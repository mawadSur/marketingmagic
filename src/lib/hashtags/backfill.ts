// Phase 6.10 — one-shot historical backfill for hashtag_usage.
//
// Scans posts.text for hashtags, joins to the most recent post_metrics
// engagement_rate, and inserts into hashtag_usage with ON CONFLICT DO
// NOTHING (the (post_id, tag) unique index makes the call idempotent —
// re-running the backfill never duplicates).
//
// Used by:
//   1. The admin endpoint /api/admin/backfill-hashtags (one-shot, CRON_SECRET-protected).
//   2. The plan-insertion path in /plans/new — we backfill only the
//      freshly-inserted posts so the recommender catches their tags on
//      the next regeneration.
//
// Designed to be cheap: caller controls workspace scope (whole-workspace
// for the admin endpoint; per-post-batch for the plan flow). Single bulk
// upsert per workspace per batch.

import { supabaseService } from "@/lib/supabase/service";
import { extractHashtags } from "./extract";

export interface BackfillResult {
  scanned: number;       // posts scanned
  with_tags: number;     // posts that had at least one tag
  inserted: number;      // rows passed to the upsert (DB de-dupes via ON CONFLICT)
  by_channel: Record<string, number>;
}

interface PostLite {
  id: string;
  channel: string;
  text: string;
  workspace_id: string;
}

/**
 * Backfill the hashtag_usage table for a list of post IDs.
 * - Looks up each post's most recent engagement_rate (post_metrics.fetched_at desc).
 * - Inserts one row per (post, tag) pair.
 * - Skips posts with empty text or no detected tags.
 * - Idempotent: ON CONFLICT (post_id, tag) DO NOTHING is enforced at the DB.
 */
export async function backfillHashtagsForPosts(postIds: string[]): Promise<BackfillResult> {
  const result: BackfillResult = { scanned: 0, with_tags: 0, inserted: 0, by_channel: {} };
  if (postIds.length === 0) return result;

  const svc = supabaseService();

  // Page through in chunks — Supabase .in() filter caps at ~1000.
  const CHUNK = 500;
  for (let i = 0; i < postIds.length; i += CHUNK) {
    const chunk = postIds.slice(i, i + CHUNK);
    const { data: posts, error: postsErr } = await svc
      .from("posts")
      .select("id, workspace_id, channel, text")
      .in("id", chunk);
    if (postsErr) throw new Error(`Backfill failed loading posts: ${postsErr.message}`);
    if (!posts || posts.length === 0) continue;
    result.scanned += posts.length;

    const rows: Array<{
      workspace_id: string;
      channel: string;
      tag: string;
      post_id: string;
      engagement_at_post: number | null;
    }> = [];

    // Engagement lookup — single round-trip for all posts in the chunk.
    // We pick the most recent post_metrics row per post_id manually
    // (Supabase doesn't expose DISTINCT ON cleanly via the JS client).
    const { data: metrics, error: metricsErr } = await svc
      .from("post_metrics")
      .select("post_id, engagement_rate, fetched_at")
      .in("post_id", chunk)
      .order("fetched_at", { ascending: false });
    if (metricsErr) throw new Error(`Backfill failed loading metrics: ${metricsErr.message}`);

    const latestByPost = new Map<string, number | null>();
    for (const m of metrics ?? []) {
      if (latestByPost.has(m.post_id)) continue; // already have the latest (sorted desc)
      latestByPost.set(m.post_id, m.engagement_rate ?? null);
    }

    for (const p of posts as PostLite[]) {
      const tags = extractHashtags(p.text ?? "");
      if (tags.length === 0) continue;
      result.with_tags += 1;
      const engagement = latestByPost.get(p.id) ?? null;
      for (const tag of tags) {
        rows.push({
          workspace_id: p.workspace_id,
          channel: p.channel,
          tag,
          post_id: p.id,
          engagement_at_post: engagement,
        });
      }
      result.by_channel[p.channel] = (result.by_channel[p.channel] ?? 0) + 1;
    }

    if (rows.length === 0) continue;

    // ON CONFLICT (post_id, tag) DO NOTHING is enforced by the unique
    // index in migration 014. Supabase's .upsert with ignoreDuplicates
    // emits the right ON CONFLICT clause.
    const { error: upsertErr } = await svc
      .from("hashtag_usage")
      .upsert(rows, { onConflict: "post_id,tag", ignoreDuplicates: true });
    if (upsertErr) throw new Error(`Backfill upsert failed: ${upsertErr.message}`);
    result.inserted += rows.length;
  }

  return result;
}

/**
 * Scan an entire workspace's history. Used by the admin endpoint.
 *
 * Bounded by `limit` to keep a single invocation cheap; if a workspace
 * has more posts the endpoint paginates client-side.
 */
export async function backfillHashtagsForWorkspace(
  workspaceId: string,
  limit = 2000,
): Promise<BackfillResult> {
  const svc = supabaseService();
  const { data: posts, error } = await svc
    .from("posts")
    .select("id")
    .eq("workspace_id", workspaceId)
    .limit(limit);
  if (error) throw new Error(`Backfill failed listing posts: ${error.message}`);
  const ids = (posts ?? []).map((p) => p.id);
  return backfillHashtagsForPosts(ids);
}
