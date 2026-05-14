// Phase 6.10 — hashtag recommendation engine.
//
// Pure data-driven aggregation: no Claude call. The /queue chip row needs
// to render fast on every post, so calling the API per-post would be
// both expensive and slow. The plan-generation step passes a digest of
// the recommendations into Claude (system prompt) so the generator can
// hint at which tags belong on each channel — that's a single call for
// the whole plan, not one per post.
//
// Ranking model:
//   1. Pull the last RECENCY_WINDOW_DAYS of `hashtag_usage` rows for
//      the workspace × channel.
//   2. Group by tag; aggregate {count, sum_engagement, last_seen}.
//   3. Score each tag by a Bayesian-shrunk recency-weighted mean of
//      engagement (so a single 0.10-engagement post doesn't dominate a
//      tag with 5 posts averaging 0.04).
//   4. Annotate as "workspace_winner" (above-average) or
//      "workspace_recent" (neutral) and cap by the per-channel policy's
//      `recommendedCount[1]`.
//
// Cold-start: workspaces with <COLD_START_THRESHOLD historical posts on
// a channel blend in COLD_START_SEEDS labelled `channel_default`.
//
// Returns suggestions sorted by confidence descending. Bluesky returns
// an empty array regardless of history — the UI uses
// getChannelHashtagPolicy().showChips to render an explanatory paragraph
// in lieu of chips.

import { supabaseService } from "@/lib/supabase/service";
import type { ChannelId } from "@/lib/channels/registry";
import type { HashtagSuggestion, HashtagReason } from "./schema";
import { extractHashtags } from "./extract";
import {
  getChannelHashtagPolicy,
  COLD_START_SEEDS,
} from "./rules";

const RECENCY_WINDOW_DAYS = 90;
// Workspaces with fewer than this many posts on a channel get blended
// suggestions (channel defaults + observed). Tuned per tasks.md hint:
// "<20 historical posts blend with channel best-practice defaults".
const COLD_START_THRESHOLD = 20;
// Bayesian prior strength: every tag is shrunk toward a global mean of
// 0.02 with this much "weight". A prior of 3 means a tag needs 3+ posts
// before its own mean dominates the shrinkage.
const PRIOR_STRENGTH = 3;
const GLOBAL_ENGAGEMENT_PRIOR = 0.02;

export interface RecommendOptions {
  // Cap on returned suggestions. Falls back to the channel policy's max.
  limit?: number;
  // When set, the recommender favours tags that already appear verbatim
  // in the draft (still subject to channel cap). Useful so the UI can
  // pre-check what the writer already wrote.
  draftText?: string | null;
}

interface HashtagUsageRow {
  tag: string;
  engagement_at_post: number | null;
  recorded_at: string;
}

/**
 * Recommend hashtags for a draft on a single workspace × channel.
 *
 * Always returns an array (possibly empty). Bluesky always returns []
 * because its policy.showChips = false. Callers should consult
 * getChannelHashtagPolicy(channel) for the UI-facing copy.
 */
export async function recommendHashtags(
  workspaceId: string,
  channel: ChannelId,
  options: RecommendOptions = {},
): Promise<HashtagSuggestion[]> {
  const policy = getChannelHashtagPolicy(channel);
  if (!policy.showChips || policy.recommendedCount[1] === 0) {
    return [];
  }

  const svc = supabaseService();
  const since = new Date(Date.now() - RECENCY_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: rows, error } = await svc
    .from("hashtag_usage")
    .select("tag, engagement_at_post, recorded_at")
    .eq("workspace_id", workspaceId)
    .eq("channel", channel)
    .gte("recorded_at", since)
    .order("recorded_at", { ascending: false });
  if (error) {
    // Don't fail the page render — the recommender is opportunistic.
    console.warn("recommendHashtags load failed:", error.message);
    return seedSuggestions(channel, policy.recommendedCount[1], options.limit);
  }

  const agg = aggregateTags((rows ?? []) as HashtagUsageRow[]);
  const totalPosts = sumDistinctPosts(rows ?? []);
  const draftTags = options.draftText ? new Set(extractHashtags(options.draftText)) : new Set<string>();

  const ranked: HashtagSuggestion[] = [];
  // Compute the workspace's own per-tag mean for the "winner" threshold.
  const wsAvgEngagement = averageEngagement(rows ?? []);

  for (const [tag, stats] of agg.entries()) {
    const shrunk = bayesianMean(stats.sumEngagement, stats.count, GLOBAL_ENGAGEMENT_PRIOR, PRIOR_STRENGTH);
    const recency = recencyFactor(stats.lastSeen);
    const confidence = clamp01(shrunk * 10 * recency); // *10 so typical 0.02–0.10 lands in 0.2–1.0
    const reason: HashtagReason = draftTags.has(tag)
      ? "draft_match"
      : shrunk > wsAvgEngagement && stats.count >= 2
        ? "workspace_winner"
        : "workspace_recent";
    ranked.push({
      tag,
      channel,
      confidence,
      reason,
      sample_size: stats.count,
    });
  }

  // Cold-start blend: if the workspace has <THRESHOLD posts on this
  // channel, mix in channel defaults at neutral confidence so the chip
  // row isn't empty. We do not blend on IG when history is rich — the
  // workspace knows itself.
  if (totalPosts < COLD_START_THRESHOLD) {
    const seenTags = new Set(ranked.map((r) => r.tag));
    for (const seed of COLD_START_SEEDS[channel]) {
      if (seenTags.has(seed)) continue;
      ranked.push({
        tag: seed,
        channel,
        confidence: 0.2,
        reason: "channel_default",
      });
    }
  }

  ranked.sort((a, b) => {
    // draft_match always wins so the UI can render "this tag is in your
    // text — keep or remove" front-and-center.
    if (a.reason === "draft_match" && b.reason !== "draft_match") return -1;
    if (b.reason === "draft_match" && a.reason !== "draft_match") return 1;
    return b.confidence - a.confidence;
  });

  const cap = options.limit ?? policy.recommendedCount[1];
  return ranked.slice(0, cap);
}

/**
 * Channel-agnostic batch helper: returns a `Map<ChannelId, string[]>` of
 * pre-ranked tag names per channel, capped at each channel's policy max.
 *
 * Used by the plan-new action to seed the system prompt with
 * "hashtagSuggestions". The plan generator only sees tag names, not
 * confidence scores — the prompt block is intentionally low-signal so
 * Claude doesn't pretend to optimize on numbers it can't verify.
 */
export async function recommendHashtagsForChannels(
  workspaceId: string,
  channels: ChannelId[],
): Promise<Map<ChannelId, string[]>> {
  const out = new Map<ChannelId, string[]>();
  const unique = Array.from(new Set(channels));
  await Promise.all(
    unique.map(async (channel) => {
      const suggestions = await recommendHashtags(workspaceId, channel);
      const tags = suggestions.map((s) => s.tag);
      if (tags.length > 0) out.set(channel, tags);
    }),
  );
  return out;
}

// ─────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────

interface TagStats {
  count: number;
  sumEngagement: number;
  lastSeen: number; // epoch ms
}

function aggregateTags(rows: HashtagUsageRow[]): Map<string, TagStats> {
  const m = new Map<string, TagStats>();
  for (const r of rows) {
    const cur = m.get(r.tag) ?? { count: 0, sumEngagement: 0, lastSeen: 0 };
    cur.count += 1;
    cur.sumEngagement += r.engagement_at_post ?? 0;
    const ts = Date.parse(r.recorded_at);
    if (Number.isFinite(ts) && ts > cur.lastSeen) cur.lastSeen = ts;
    m.set(r.tag, cur);
  }
  return m;
}

function bayesianMean(
  sumEngagement: number,
  count: number,
  prior: number,
  priorWeight: number,
): number {
  // Shrunk toward the prior: m = (sum + prior*priorWeight) / (count + priorWeight)
  return (sumEngagement + prior * priorWeight) / (count + priorWeight);
}

// Exponential decay; 30-day half life. Same shape as Phase 6.5 decay so
// timing + hashtag intelligence weight history consistently.
function recencyFactor(lastSeenMs: number): number {
  if (!lastSeenMs) return 0.5;
  const daysAgo = Math.max(0, (Date.now() - lastSeenMs) / (24 * 60 * 60 * 1000));
  const halfLife = 30;
  return Math.pow(0.5, daysAgo / halfLife);
}

function averageEngagement(rows: HashtagUsageRow[]): number {
  if (rows.length === 0) return GLOBAL_ENGAGEMENT_PRIOR;
  const total = rows.reduce((sum, r) => sum + (r.engagement_at_post ?? 0), 0);
  return total / rows.length;
}

function sumDistinctPosts(rows: { tag?: string }[]): number {
  // Approximation: distinct-tag count is a cheap proxy for "post breadth"
  // when we don't carry post_id through the select. The recommender uses
  // this only to decide cold-start blend — under-counting just blends a
  // little more often, which is the safe direction.
  return new Set(rows.map((r) => r.tag)).size;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function seedSuggestions(
  channel: ChannelId,
  cap: number,
  limit: number | undefined,
): HashtagSuggestion[] {
  const max = limit ?? cap;
  return COLD_START_SEEDS[channel].slice(0, max).map((tag) => ({
    tag,
    channel,
    confidence: 0.2,
    reason: "channel_default" as const,
  }));
}
