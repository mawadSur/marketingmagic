// Phase 6.6 — per-handle outlier detection.
//
// "Top 10% by engagement_rate vs that account's own baseline." We do not
// compare across handles because audience sizes vary 100x; one big account
// would drown every small handle's winners.
//
// engagement_rate is computed by computeEngagementRate() at insert time
// (see cron route). When a post has impressions reported we divide
// (likes+reposts+replies) by impressions; otherwise we use raw engagement
// counts and let the percentile do the normalising.
//
// We require MIN_POSTS_FOR_BASELINE before flagging anything — a handle
// with 3 cached posts can't tell us which ones are outliers.

import type { Database } from "@/lib/db/types";

type CompetitorPostRow = Database["public"]["Tables"]["competitor_posts"]["Row"];

export const MIN_POSTS_FOR_BASELINE = 8;
export const WINNER_TOP_DECILE = 0.10; // top 10%
export const WINNER_LOOKBACK_DAYS = 90;

export interface OutlierFlag {
  postId: string;
  is_winner: boolean;
}

// Pure function for testability. Returns one OutlierFlag per input post.
// `posts` should be all posts for ONE watch_handle within the lookback
// window; the caller batches per-handle and inserts the results.
export function flagOutliers(posts: CompetitorPostRow[]): OutlierFlag[] {
  if (posts.length < MIN_POSTS_FOR_BASELINE) {
    return posts.map((p) => ({ postId: p.id, is_winner: false }));
  }
  const ranked = posts
    .filter((p) => p.engagement_rate != null && Number.isFinite(p.engagement_rate))
    .map((p) => ({ id: p.id, rate: p.engagement_rate ?? 0 }))
    .sort((a, b) => b.rate - a.rate);

  if (ranked.length === 0) {
    return posts.map((p) => ({ postId: p.id, is_winner: false }));
  }

  // Cutoff index: top decile rounded up to ≥1 so a handle with exactly 10
  // posts surfaces its single best one rather than zero.
  const cutoffIdx = Math.max(1, Math.ceil(ranked.length * WINNER_TOP_DECILE));
  const winnerIds = new Set(ranked.slice(0, cutoffIdx).map((r) => r.id));
  return posts.map((p) => ({ postId: p.id, is_winner: winnerIds.has(p.id) }));
}

// Engagement rate from the per-channel raw counts. Caller passes already-
// normalised numbers; this is just the formula. Returning null when there's
// no signal is intentional — it propagates into the row and the outlier
// pass excludes it cleanly.
export function computeEngagementRate(input: {
  likes: number | null;
  reposts: number | null;
  replies: number | null;
  impressions: number | null;
}): number | null {
  const likes = input.likes ?? 0;
  const reposts = input.reposts ?? 0;
  const replies = input.replies ?? 0;
  const engagement = likes + reposts + replies;
  // Prefer impressions-normalised when available; otherwise return the
  // raw engagement count and let the percentile do the comparing.
  if (input.impressions != null && input.impressions > 0) {
    return engagement / input.impressions;
  }
  if (engagement === 0 && input.impressions == null) return null;
  return engagement;
}
