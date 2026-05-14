// Phase 6.8 — thread metrics roll-up.
//
// A thread is N rows on `posts`, each with its own `post_metrics` row.
// At the dashboard / plan-detail level we want to see ONE row per
// thread with the aggregated stats; the per-tweet detail view drills
// into individual tweet metrics.
//
// Aggregation rules:
// - impressions: max across tweets (impressions are sticky; the hook
//   typically has the highest count). Summing would double-count
//   readers who saw multiple tweets in their feed.
// - likes / replies / reposts / clicks: sum. These are per-tweet
//   engagement events; the thread's "total reach signal" is the sum.
// - engagement_rate: aggregate engagement (likes+replies+reposts) /
//   aggregate impressions. NOT the average of per-tweet rates — that
//   would be skewed by tail-tweet low-volume.

import type { SupabaseClient } from "@supabase/supabase-js";
import { readThreadMeta } from "./schema";

export interface ThreadMetricsRow {
  postId: string;
  tweet_index: number;
  role: "hook" | "body" | "close";
  external_id: string | null;
  impressions: number;
  likes: number;
  replies: number;
  reposts: number;
  clicks: number;
  fetched_at: string | null;
}

export interface ThreadMetricsRollup {
  ideaId: string;
  totalTweets: number;
  postedTweets: number;
  // Aggregated stats — see file header for the per-stat rule.
  impressions: number;
  likes: number;
  replies: number;
  reposts: number;
  clicks: number;
  engagement_rate: number | null;
  // Per-tweet breakdown for the detail view. Ordered by tweet_index.
  perTweet: ThreadMetricsRow[];
}

interface PostRowLite {
  id: string;
  external_id: string | null;
  generation_metadata: unknown;
}

interface MetricRowLite {
  post_id: string;
  fetched_at: string;
  impressions: number | null;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  clicks: number | null;
}

export async function rollupThreadMetrics(
  svc: SupabaseClient,
  ideaId: string,
): Promise<ThreadMetricsRollup | null> {
  // Pull all rows in the thread + their latest metrics row.
  const { data: rows, error } = await svc
    .from("posts")
    .select("id, external_id, generation_metadata, post_metrics(post_id, fetched_at, impressions, likes, replies, reposts, clicks)")
    .eq("idea_id", ideaId);
  if (error) throw new Error(`rollupThreadMetrics: ${error.message}`);
  if (!rows || rows.length === 0) return null;

  // Filter to thread-tagged rows + extract per-row metrics (latest one
  // per post).
  type Joined = PostRowLite & { post_metrics: MetricRowLite[] };
  const perTweet: ThreadMetricsRow[] = [];
  for (const r of rows as unknown as Joined[]) {
    const meta = readThreadMeta(r.generation_metadata);
    if (!meta) continue;
    const metrics = Array.isArray(r.post_metrics) ? r.post_metrics : [];
    const latest = metrics
      .slice()
      .sort((a, b) => (a.fetched_at < b.fetched_at ? 1 : -1))[0];
    perTweet.push({
      postId: r.id,
      tweet_index: meta.tweet_index,
      role: meta.role,
      external_id: r.external_id,
      impressions: latest?.impressions ?? 0,
      likes: latest?.likes ?? 0,
      replies: latest?.replies ?? 0,
      reposts: latest?.reposts ?? 0,
      clicks: latest?.clicks ?? 0,
      fetched_at: latest?.fetched_at ?? null,
    });
  }
  if (perTweet.length === 0) return null;
  perTweet.sort((a, b) => a.tweet_index - b.tweet_index);

  const impressions = perTweet.reduce((m, r) => Math.max(m, r.impressions), 0);
  const likes = perTweet.reduce((s, r) => s + r.likes, 0);
  const replies = perTweet.reduce((s, r) => s + r.replies, 0);
  const reposts = perTweet.reduce((s, r) => s + r.reposts, 0);
  const clicks = perTweet.reduce((s, r) => s + r.clicks, 0);
  const engagement_rate =
    impressions > 0 ? (likes + replies + reposts) / impressions : null;

  return {
    ideaId,
    totalTweets: perTweet[0].tweet_index === 1 ? perTweet.length : perTweet.length, // length-based; tweets array is dense by construction
    postedTweets: perTweet.filter((r) => r.external_id !== null).length,
    impressions,
    likes,
    replies,
    reposts,
    clicks,
    engagement_rate,
    perTweet,
  };
}
