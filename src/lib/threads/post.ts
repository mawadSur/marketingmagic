// Phase 6.8 — thread posting orchestration.
//
// Glue between the cron picker and `xPostThread`. Loads all `posts`
// rows that belong to a given X thread (idea_id-keyed), resolves the
// next-unposted index, calls `xPostThread` with the appropriate tail,
// then persists per-row `external_id` + ledger entries.
//
// Idempotency:
// - Per-row ledger key is `post:<post_id>` (same shape as single posts).
// - Before posting we re-attach any rows whose ledger entry already
//   exists (covers the crash-after-X-but-before-DB-update window).
// - `xPostThread`'s `startInReplyTo` is the last-known external_id from
//   the database, so a crash mid-thread resumes against the right parent.

import type { SupabaseClient } from "@supabase/supabase-js";
import { xPostThread, type XCredentials } from "@/lib/social/x";
import { readThreadMeta, type ThreadRowMeta } from "./schema";

export interface ThreadRow {
  id: string;
  workspace_id: string;
  social_account_id: string;
  channel: string; // 'x'
  text: string;
  status: string;
  external_id: string | null;
  generation_metadata: unknown;
  idea_id: string | null;
}

export interface ParsedThreadRow extends ThreadRow {
  thread: ThreadRowMeta;
}

// Load + validate + sort all rows of a thread. Throws when the rows
// don't form a coherent thread (mixed channels, gaps in tweet_index,
// missing thread meta).
export async function loadThreadRows(
  svc: SupabaseClient,
  ideaId: string,
): Promise<ParsedThreadRow[]> {
  const { data, error } = await svc
    .from("posts")
    .select(
      "id, workspace_id, social_account_id, channel, text, status, external_id, generation_metadata, idea_id",
    )
    .eq("idea_id", ideaId);
  if (error) throw new Error(`loadThreadRows: ${error.message}`);
  const rows = (data ?? []) as ThreadRow[];
  if (rows.length === 0) throw new Error(`Thread ${ideaId} has no rows`);

  const parsed: ParsedThreadRow[] = [];
  for (const r of rows) {
    if (r.channel !== "x") {
      throw new Error(`Thread ${ideaId}: non-X row ${r.id} (${r.channel})`);
    }
    const meta = readThreadMeta(r.generation_metadata);
    if (!meta) throw new Error(`Thread ${ideaId}: row ${r.id} missing thread meta`);
    parsed.push({ ...r, thread: meta });
  }
  parsed.sort((a, b) => a.thread.tweet_index - b.thread.tweet_index);

  // Sanity: 1..N strict sequence.
  for (let i = 0; i < parsed.length; i++) {
    if (parsed[i].thread.tweet_index !== i + 1) {
      throw new Error(
        `Thread ${ideaId}: gap at tweet_index ${i + 1} (saw ${parsed[i].thread.tweet_index})`,
      );
    }
  }
  return parsed;
}

// True when this set of rows represents an X thread: >=2 rows, all
// channel=x, every row has thread meta. Cheap pre-check used by the
// cron picker before it bothers to load the full row set.
export function looksLikeThread(
  rows: Array<{ channel: string; generation_metadata: unknown }>,
): boolean {
  if (rows.length < 2) return false;
  for (const r of rows) {
    if (r.channel !== "x") return false;
    if (!readThreadMeta(r.generation_metadata)) return false;
  }
  return true;
}

export interface PostThreadOutcome {
  ideaId: string;
  totalTweets: number;
  posted: number; // count newly posted in *this* run
  alreadyPosted: number; // count already posted before this run
  failureAtIndex: number | null; // 1-based; null on full success
  failureReason: string | null;
}

// Post (or resume posting) a thread.
//
// Sequence:
// 1. Load all rows, sort by tweet_index.
// 2. Reconcile against the ledger: if rows are unposted in the DB but
//    have a ledger hit, mark them posted and trim the tail.
// 3. Find the first row without external_id (the resume point).
// 4. If everything is posted, no-op (idempotent).
// 5. Otherwise call xPostThread with the tail slice + the previous
//    tweet's external_id as `startInReplyTo`.
// 6. For each tweet that posted, write external_id + status=posted,
//    insert a social_posts_ledger row.
// 7. On partial failure: mark the failing row + every later row
//    'failed' with a clear reason. The retry action clears them
//    back to 'scheduled' and we pick up where we left off.
export async function postThread(
  svc: SupabaseClient,
  ideaId: string,
  creds: XCredentials,
): Promise<PostThreadOutcome> {
  const rows = await loadThreadRows(svc, ideaId);
  const total = rows.length;

  // Reconcile rows against the ledger first. Covers the rare crash-after-X-
  // post-but-before-DB-update window.
  const keysWithoutExternal = rows.filter((r) => !r.external_id).map((r) => `post:${r.id}`);
  if (keysWithoutExternal.length > 0) {
    const { data: ledgerHits } = await svc
      .from("social_posts_ledger")
      .select("event_key, external_id")
      .eq("channel", "x")
      .in("event_key", keysWithoutExternal);
    const hitsByKey = new Map<string, string | null>();
    for (const h of ledgerHits ?? []) {
      hitsByKey.set(h.event_key as string, (h.external_id as string | null) ?? null);
    }
    if (hitsByKey.size > 0) {
      const nowIso = new Date().toISOString();
      for (const r of rows) {
        if (r.external_id) continue;
        const hit = hitsByKey.get(`post:${r.id}`);
        if (hit) {
          r.external_id = hit;
          await svc
            .from("posts")
            .update({ status: "posted", external_id: hit, posted_at: nowIso })
            .eq("id", r.id);
        }
      }
    }
  }

  // Find resume point post-reconcile.
  const firstUnpostedIdx = rows.findIndex((r) => !r.external_id);
  const alreadyPosted = firstUnpostedIdx === -1 ? total : firstUnpostedIdx;
  if (firstUnpostedIdx === -1) {
    return {
      ideaId,
      totalTweets: total,
      posted: 0,
      alreadyPosted,
      failureAtIndex: null,
      failureReason: null,
    };
  }

  const tail = rows.slice(firstUnpostedIdx);
  const startInReplyTo =
    firstUnpostedIdx > 0 ? rows[firstUnpostedIdx - 1].external_id ?? undefined : undefined;

  const texts = tail.map((r) => r.text);
  const result = await xPostThread(creds, texts, { startInReplyTo });

  // Persist successes.
  const nowIso = new Date().toISOString();
  for (let i = 0; i < result.tweetIds.length; i++) {
    const row = tail[i];
    const tweetId = result.tweetIds[i];
    // Ledger insert (unique on (channel, event_key)). Treat duplicates
    // as success — they mean the same idempotency key already wrote.
    const { error: ledgerErr } = await svc.from("social_posts_ledger").insert({
      workspace_id: row.workspace_id,
      channel: "x",
      event_key: `post:${row.id}`,
      external_id: tweetId,
      payload: { text: row.text, thread_index: row.thread.tweet_index },
    });
    if (ledgerErr && !ledgerErr.message.includes("duplicate")) {
      console.warn(`thread ledger write failed for ${row.id}: ${ledgerErr.message}`);
    }
    await svc
      .from("posts")
      .update({
        status: "posted",
        external_id: tweetId,
        posted_at: nowIso,
        failure_reason: null,
      })
      .eq("id", row.id);
  }

  // Partial failure: mark the failing row + every later row failed so
  // the queue UI can surface a retry affordance.
  if (result.lastError) {
    const failingIndexInTail = result.lastError.tweetIndex; // 0-based within tail
    const failingRow = tail[failingIndexInTail];
    const oneBased = failingRow.thread.tweet_index;
    const reason =
      `thread interrupted at tweet ${oneBased} of ${total}: ${result.lastError.error}`.slice(0, 1000);
    const failedIds: string[] = [];
    for (let i = failingIndexInTail; i < tail.length; i++) {
      failedIds.push(tail[i].id);
    }
    if (failedIds.length > 0) {
      await svc
        .from("posts")
        .update({ status: "failed", failure_reason: reason })
        .in("id", failedIds);
    }
    return {
      ideaId,
      totalTweets: total,
      posted: result.tweetIds.length,
      alreadyPosted,
      failureAtIndex: oneBased,
      failureReason: reason,
    };
  }

  return {
    ideaId,
    totalTweets: total,
    posted: result.tweetIds.length,
    alreadyPosted,
    failureAtIndex: null,
    failureReason: null,
  };
}
