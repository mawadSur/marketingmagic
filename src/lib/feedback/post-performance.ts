// Per-post performance scoring — the "which of my posts won, which flopped"
// layer that feeds the planner's exemplar block (PostExemplar) and the
// learning loop.
//
// Where `src/lib/analytics/themes.ts` answers "which *themes* work" with a
// Bayesian-shrinkage model, this module answers the narrower, post-level
// question: given a single post's engagement rate, how does it stack up
// against the rest of this workspace's recent posts?
//
// Design choices (mirrors src/lib/explain/outliers.ts where it overlaps, but
// adds two things outliers.ts doesn't have):
//
//   1. DECAY-WEIGHTED baseline. outliers.ts uses a plain median over a 28d
//      window. Here the corpus is weighted by `decayWeightFor(posted_at)`
//      (half-life 30d, shared with Smart Timing + theme analytics) so a post
//      is judged against what *recently* worked, not a 4-week-old normal.
//      The "weighted median" is the engagement_rate at the 50%-cumulative-
//      weight point of the weight-sorted corpus.
//
//   2. A SAVES signal. Saves are the strongest intent signal on IG/TikTok
//      but live outside engagement_rate. A post in the top decile of corpus
//      saves earns a +10 score bonus (capped at 100). Posts with no saves
//      datum are simply left unchanged — absence of saves is not a penalty.
//
// `scorePost` is PURE (corpus in, verdict out — easy to unit-test).
// `loadWorkspacePerformance` does the one DB read and scores every post.

import { supabaseService } from "@/lib/supabase/service";
import { decayWeightFor } from "@/lib/timing/decay";

// Same 28-day lookback the outlier detector uses, so the two surfaces never
// disagree about which posts are in-window.
const BASELINE_DAYS = 28;
const MS_PER_HOUR = 60 * 60 * 1000;

// Minimum effective (weight-bearing) corpus points before we'll emit a
// confident verdict. Mirrors src/lib/explain/outliers.ts BASELINE_MIN_SAMPLE:
// on a 1-2 post workspace everything looks like an outlier, so we hold the
// verdict at 'pending' until there's real signal.
const BASELINE_MIN_SAMPLE = 4;

// Verdict thresholds. Aligned with outliers.ts winner/loser multipliers
// (1.5 / 0.5) but with two extra mid-tiers so the planner can say "more like
// these" with a softer band than the raw outlier set.
const WINNER_RATIO = 1.5;
const STRONG_RATIO = 1.1;
const UNDERPERFORMER_RATIO = 0.5;

// A post younger than this can't be judged — metrics are still settling.
const PENDING_AGE_HOURS = 48;

export type PostVerdict = "winner" | "strong" | "average" | "underperformer" | "pending";

export interface PostPerformance {
  postId: string;
  // The post's own latest engagement_rate (null when we have no metric row).
  engagementRate: number | null;
  saves: number | null;
  // Decay-weighted median engagement_rate of the corpus (0 when corpus empty).
  baseline: number;
  // engagement_rate / baseline. null when baseline is 0 (can't divide).
  ratio: number | null;
  // Decay-weighted fraction of the corpus strictly below this rate, ×100.
  percentile: number | null;
  verdict: PostVerdict;
  // 0..100. null when the post is pending / has no rate to score.
  score: number | null;
}

interface CorpusPoint {
  engagement_rate: number;
  posted_at: string;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// Hours since `postedAt` relative to `now`. Negative (future) clamps to 0.
function ageHours(postedAt: string, now: Date): number {
  const ts = new Date(postedAt).getTime();
  if (Number.isNaN(ts)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (now.getTime() - ts) / MS_PER_HOUR);
}

// Decay-weighted median: sort the corpus by rate, walk the cumulative weight,
// and return the rate at which we cross 50% of the total weight. This is the
// weighted analogue of the plain median in outliers.ts — a 60-day-old normal
// post barely nudges the line, a yesterday post counts full.
function weightedMedian(corpus: CorpusPoint[], now: Date): number {
  if (corpus.length === 0) return 0;
  const weighted = corpus
    .map((p) => ({ rate: p.engagement_rate, w: decayWeightFor(p.posted_at, now) }))
    .filter((p) => p.w > 0)
    .sort((a, b) => a.rate - b.rate);
  if (weighted.length === 0) return 0;

  const total = weighted.reduce((s, p) => s + p.w, 0);
  if (total <= 0) return 0;

  const half = total / 2;
  let cumulative = 0;
  for (let i = 0; i < weighted.length; i++) {
    cumulative += weighted[i]!.w;
    // Crossing PAST half lands the median squarely on this rate.
    if (cumulative > half) return weighted[i]!.rate;
    // Landing EXACTLY on half: the median is the boundary between this rate
    // and the next, so interpolate (weighted-median analogue of the
    // even-length plain median in outliers.ts). Without a next element this
    // is the last rate, so fall through and return it.
    if (cumulative === half && i + 1 < weighted.length) {
      return (weighted[i]!.rate + weighted[i + 1]!.rate) / 2;
    }
  }
  // Fallback (floating-point): the largest rate carries the remaining weight.
  return weighted[weighted.length - 1]!.rate;
}

// Decay-weighted fraction of corpus *strictly* below `rate`, expressed 0..100.
// Weighting means a post beats "what recently worked", not "what worked a
// month ago" — consistent with the baseline.
function weightedPercentile(rate: number, corpus: CorpusPoint[], now: Date): number {
  if (corpus.length === 0) return 0;
  let below = 0;
  let total = 0;
  for (const p of corpus) {
    const w = decayWeightFor(p.posted_at, now);
    if (w <= 0) continue;
    total += w;
    if (p.engagement_rate < rate) below += w;
  }
  if (total <= 0) return 0;
  return (below / total) * 100;
}

// "Top decile of corpus saves" — the gate for the +10 saves bonus.
//
// The contract wants saves-relative-to-reach (saves/impressions), but scorePost
// is PURE and the corpus it receives is engagement_rate + posted_at only — no
// per-post saves series. So the best available, self-contained stand-in is the
// post's own decay-weighted engagement percentile: a post counts as top-decile
// on saves when it has saves AND its engagement_rate lands at/above the 90th
// weighted percentile of the corpus (the same "is this reach top-decile?" test
// reach-normalised saves would otherwise answer). This keeps the function pure
// and the bonus conservative — it only ever *adds*, and a saves==null post is
// never penalised.
//
// `selfWeight` (when > 0) is the post's OWN decay weight inside `corpus`. We
// subtract it from the percentile denominator so the post isn't measured
// against itself: weightedPercentile counts STRICTLY below, so a top performer
// in a self-including corpus can never reach the 90th percentile (its own
// weight inflates the denominator but is never in `below`), and the +10 bonus
// would almost never fire on small corpora. Excluding self lets a genuine top
// performer clear p90.
function savesTopDecile(
  saves: number | null,
  engagementRate: number | null,
  corpus: CorpusPoint[],
  now: Date,
  selfWeight = 0,
): boolean {
  if (saves == null) return false;
  if (saves <= 0) return false;
  if (engagementRate == null) return false;
  // Proxy: without a saves series, a high-saves post is one whose engagement
  // (the only corpus signal) is itself top-decile. p90 weighted percentile,
  // measured against the corpus MINUS this post's own weight.
  const pct = weightedPercentileExcludingSelf(engagementRate, corpus, now, selfWeight);
  return pct >= 90;
}

// weightedPercentile, but with `selfWeight` of weight (at exactly `rate`)
// removed from the denominator — i.e. the post is scored against everyone but
// itself. With selfWeight 0 this is identical to weightedPercentile.
function weightedPercentileExcludingSelf(
  rate: number,
  corpus: CorpusPoint[],
  now: Date,
  selfWeight: number,
): number {
  let below = 0;
  let total = 0;
  for (const p of corpus) {
    const w = decayWeightFor(p.posted_at, now);
    if (w <= 0) continue;
    total += w;
    if (p.engagement_rate < rate) below += w;
  }
  // The self point sits AT `rate` (not strictly below), so it never adds to
  // `below`; we only drop it from `total`. Guard against over-subtraction.
  const denom = Math.max(0, total - selfWeight);
  if (denom <= 0) return 0;
  return (below / denom) * 100;
}

// ── scorePost — PURE. ────────────────────────────────────────────────────────
// Given one post's metric snapshot and the (full-workspace) engagement corpus,
// returns the verdict + score. No I/O, no clock except the injectable `now`.
//
//   opts.excludeSelf — set by loadWorkspacePerformance, where the scored post
//     is itself a member of `corpus`. When true, the post's own decay weight is
//     removed from the saves top-decile percentile denominator so it isn't
//     measured against itself (without this a top performer can never clear p90
//     on small corpora and the +10 saves bonus almost never fires).
export function scorePost(
  metric: { engagement_rate: number | null; saves: number | null; posted_at: string },
  corpus: Array<{ engagement_rate: number; posted_at: string }>,
  now: Date = new Date(),
  opts: { excludeSelf?: boolean } = {},
): PostPerformance {
  const baseline = weightedMedian(corpus, now);

  // Effective corpus = points that actually carry decay weight. We gate on
  // this (not corpus.length) so a window of all-stale posts can't masquerade
  // as enough signal.
  let effectivePoints = 0;
  for (const p of corpus) {
    if (decayWeightFor(p.posted_at, now) > 0) effectivePoints++;
  }

  // Not enough signal yet (mirrors src/lib/explain/outliers.ts: fewer than 4
  // baseline points, or a zero baseline). Force 'pending' so the existing
  // pending filters drop the chip + exemplars rather than emitting a confident
  // winner/underperformer on a 1-2 post workspace.
  const tooFresh = ageHours(metric.posted_at, now) < PENDING_AGE_HOURS;
  const lowSignal = effectivePoints < BASELINE_MIN_SAMPLE || baseline <= 0;
  if (tooFresh || metric.engagement_rate == null || lowSignal) {
    return {
      postId: "",
      engagementRate: metric.engagement_rate,
      saves: metric.saves,
      baseline,
      ratio: null,
      percentile: metric.engagement_rate == null ? null : weightedPercentile(metric.engagement_rate, corpus, now),
      verdict: "pending",
      score: null,
    };
  }

  const rate = metric.engagement_rate;
  const ratio = baseline > 0 ? rate / baseline : null;
  const percentile = weightedPercentile(rate, corpus, now);

  // Verdict from the ratio bands. With no baseline (ratio null) we can't rank
  // the post against peers — treat as average so it neither wins nor flops.
  let verdict: PostVerdict;
  if (ratio == null) verdict = "average";
  else if (ratio >= WINNER_RATIO) verdict = "winner";
  else if (ratio >= STRONG_RATIO) verdict = "strong";
  else if (ratio <= UNDERPERFORMER_RATIO) verdict = "underperformer";
  else verdict = "average";

  // Self weight to drop from the saves percentile when the scored post is a
  // corpus member (loadWorkspacePerformance path).
  const selfWeight = opts.excludeSelf ? decayWeightFor(metric.posted_at, now) : 0;

  // Score: 50 = exactly at baseline, scales linearly with ratio, clamped to
  // 0..100. A saves top-decile post earns +10 (still capped at 100). No
  // baseline -> we can't compute a ratio score, so leave score null.
  let score: number | null = null;
  if (ratio != null) {
    score = clamp(Math.round(50 * ratio), 0, 100);
    if (savesTopDecile(metric.saves, rate, corpus, now, selfWeight)) {
      score = clamp(score + 10, 0, 100);
    }
  }

  return {
    postId: "",
    engagementRate: rate,
    saves: metric.saves,
    baseline,
    ratio,
    percentile,
    verdict,
    score,
  };
}

// ── loadWorkspacePerformance — async. ────────────────────────────────────────
// One read of posted posts + their latest post_metrics over the 28d window
// (same query shape as src/lib/explain/outliers.ts), then scorePost each.
// Returns a Map keyed by postId.
//
//   opts.postIds — filter the RETURNED ids only. The corpus (baseline) is
//                  always the full workspace so a single post is still judged
//                  against everything, not against itself.
//   opts.days    — override the lookback window (default 28).

interface RawPerfRow {
  id: string;
  posted_at: string | null;
  post_metrics: Array<{ engagement_rate: number | null; saves: number | null; fetched_at: string }>;
}

// Latest-by-fetched_at snapshot for a post (mirrors outliers.ts latestEngagement).
function latestMetric(
  row: RawPerfRow,
): { engagement_rate: number | null; saves: number | null } {
  if (!row.post_metrics || row.post_metrics.length === 0) {
    return { engagement_rate: null, saves: null };
  }
  const latest = row.post_metrics
    .slice()
    .sort((a, b) => +new Date(b.fetched_at) - +new Date(a.fetched_at))[0]!;
  return { engagement_rate: latest.engagement_rate ?? null, saves: latest.saves ?? null };
}

export async function loadWorkspacePerformance(
  workspaceId: string,
  opts: { postIds?: string[]; days?: number } = {},
): Promise<Map<string, PostPerformance>> {
  const svc = supabaseService();
  const days = opts.days ?? BASELINE_DAYS;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await svc
    .from("posts")
    .select("id, posted_at, post_metrics(engagement_rate, saves, fetched_at)")
    .eq("workspace_id", workspaceId)
    .eq("status", "posted")
    .gte("posted_at", since);

  const result = new Map<string, PostPerformance>();
  if (error || !data) return result;

  const rows = data as unknown as RawPerfRow[];
  const now = new Date();

  // Build the corpus once: every posted post with a latest engagement_rate,
  // tagged with its posted_at for decay weighting.
  const corpus: CorpusPoint[] = [];
  for (const row of rows) {
    if (!row.posted_at) continue;
    const { engagement_rate } = latestMetric(row);
    if (engagement_rate == null) continue;
    corpus.push({ engagement_rate, posted_at: row.posted_at });
  }

  // Optional filter applies to the RETURNED ids only — corpus stays full.
  const wanted = opts.postIds ? new Set(opts.postIds) : null;

  for (const row of rows) {
    if (!row.posted_at) continue;
    if (wanted && !wanted.has(row.id)) continue;
    const { engagement_rate, saves } = latestMetric(row);
    const perf = scorePost(
      { engagement_rate, saves, posted_at: row.posted_at },
      corpus,
      now,
      // The post is itself a member of `corpus`; drop its own weight from the
      // saves top-decile percentile so it isn't measured against itself.
      { excludeSelf: true },
    );
    perf.postId = row.id;
    result.set(row.id, perf);
  }

  return result;
}
