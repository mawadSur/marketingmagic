// Auto-tag persistence — generate tags for one or many posts and write them
// into posts.tags (migration 052). Service-role; callers have already
// authorized the workspace.
//
// Sits between generateTags() (pure-ish LLM orchestration) and the plan /
// queue surfaces. Two entry points:
//   • generateAndStoreTagsForPost(postId)  — regenerate one draft's tags.
//   • generateAndStoreTagsForPlan(...)      — batch-generate at plan time,
//     blending the workspace's recency-weighted recommendations per channel.
//
// Both are BEST-EFFORT by contract: a tag-generation failure must never sink
// the plan/post it rides on. The caller wraps these in try/catch and logs.

import { supabaseService } from "@/lib/supabase/service";
import type { Database } from "@/lib/db/types";
import type { ChannelId } from "@/lib/channels/registry";
import { ENABLED_CHANNELS } from "@/lib/channels/registry";
import { generateTags, tagBoundsForChannel } from "@/lib/tags/generate";

type Brief = Database["public"]["Tables"]["brand_briefs"]["Row"];

// Bound the concurrent LLM calls so a 4-week × multi-channel plan doesn't open
// 50 sockets at once. Tags are tiny (max_tokens 512) so a modest fan-out is
// fine; this just keeps us well under any per-connection ceiling.
const CONCURRENCY = 5;

type BriefContext = Pick<Brief, "product_description" | "voice_profile"> | null;

interface PlanPostTarget {
  postId: string;
  channel: string;
  text: string;
}

/**
 * Batch-generate tags for freshly-inserted plan posts and persist them.
 *
 * `recommendedByChannel` is the SAME Map the planner already builds via
 * recommendHashtagsForChannels() — we reuse it as the workspace-history blend
 * so we don't re-query hashtag_usage. Posts on no-tag channels (Bluesky, and
 * X by default) are skipped without an LLM call.
 *
 * Returns the count of posts whose tags were written (best-effort; failures
 * are swallowed per-post so one bad call can't abort the batch).
 */
export async function generateAndStoreTagsForPlan(
  targets: PlanPostTarget[],
  brief: BriefContext,
  recommendedByChannel: Map<ChannelId, string[]>,
): Promise<number> {
  // Drop targets whose channel takes no tags up front — no work, no call.
  const work = targets.filter((t) => {
    if (!ENABLED_CHANNELS.includes(t.channel as ChannelId)) return false;
    return tagBoundsForChannel(t.channel as ChannelId).enabled;
  });
  if (work.length === 0) return 0;

  const svc = supabaseService();
  let written = 0;

  // Simple bounded-concurrency worker pool over the target list.
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= work.length) return;
      const t = work[i];
      const channel = t.channel as ChannelId;
      try {
        const tags = await generateTags({
          text: t.text,
          channel,
          brief,
          recommended: recommendedByChannel.get(channel) ?? [],
        });
        // Only write when we actually produced tags — leave the '{}' default
        // otherwise so an empty result doesn't look like a deliberate clear.
        if (tags.length > 0) {
          const { error } = await svc.from("posts").update({ tags }).eq("id", t.postId);
          if (!error) written += 1;
        }
      } catch (err) {
        console.warn(`Auto-tag generation failed for post ${t.postId}:`, err);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, work.length) }, () => worker()));
  return written;
}

/**
 * (Re)generate tags for a single existing draft and persist them. Used by the
 * /queue "Regenerate tags" action. Loads the post + brief, blends the
 * workspace's recency-weighted recommendations for the post's channel, and
 * writes posts.tags.
 *
 * Returns the new tag set, or null on failure (the caller surfaces an error).
 */
export async function generateAndStoreTagsForPost(postId: string): Promise<string[] | null> {
  const svc = supabaseService();
  const { data: post, error } = await svc
    .from("posts")
    .select("id, workspace_id, channel, text")
    .eq("id", postId)
    .maybeSingle();
  if (error || !post) return null;

  const channel = post.channel as ChannelId;
  if (!ENABLED_CHANNELS.includes(channel) || !tagBoundsForChannel(channel).enabled) {
    // No-tag channel: persist the empty set explicitly (a deliberate clear is
    // the right answer here) and return it.
    await svc.from("posts").update({ tags: [] }).eq("id", postId);
    return [];
  }

  // Brand context + recency-weighted recommendations for the blend. Both
  // best-effort — generateTags works without either.
  const [{ data: brief }, recommended] = await Promise.all([
    svc
      .from("brand_briefs")
      .select("product_description, voice_profile")
      .eq("workspace_id", post.workspace_id)
      .maybeSingle(),
    loadRecommended(post.workspace_id, channel),
  ]);

  let tags: string[];
  try {
    tags = await generateTags({
      text: post.text,
      channel,
      brief: brief ?? null,
      recommended,
    });
  } catch (err) {
    console.warn(`Auto-tag regeneration failed for post ${postId}:`, err);
    return null;
  }

  const { error: updErr } = await svc.from("posts").update({ tags }).eq("id", postId);
  if (updErr) return null;
  return tags;
}

// Recency-weighted recommendations for the blend. Imported lazily-ish via a
// thin wrapper so the recommender's supabase dependency only loads when a
// single-post regenerate actually runs (the plan path passes its own Map).
async function loadRecommended(workspaceId: string, channel: ChannelId): Promise<string[]> {
  try {
    const { recommendHashtags } = await import("@/lib/hashtags/recommend");
    const suggestions = await recommendHashtags(workspaceId, channel);
    return suggestions.map((s) => s.tag);
  } catch (err) {
    console.warn("loadRecommended failed:", err);
    return [];
  }
}
