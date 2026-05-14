import { supabaseService } from "@/lib/supabase/service";
import type { Channel } from "@/lib/db/types";

// Outlier window + thresholds. Documented because the task spec asks us to
// pick: we use the *median* (not mean) over a rolling 28-day window. Median
// is robust to a single viral post that would otherwise pull the mean up
// and hide the workshop median.
//
//   baseline           = median(engagement_rate) over last 28d posted posts
//   winner threshold   = engagement_rate >= 1.5 * baseline
//   loser  threshold   = engagement_rate <= 0.5 * baseline
//   age gate           = posted_at <= now() - 48h   (metrics need time to settle)
//
// We require at least 4 baseline data points to avoid noisy outlier calls
// on workspaces with 1-2 posts (where everything looks like an outlier).
const BASELINE_DAYS = 28;
const BASELINE_MIN_SAMPLE = 4;
const AGE_GATE_HOURS = 48;
const WINNER_MULTIPLIER = 1.5;
const LOSER_MULTIPLIER = 0.5;

export interface OutlierPost {
  id: string;
  text: string;
  theme: string | null;
  channel: Channel;
  posted_at: string;
  engagement_rate: number;
  baseline: number;
  ratio: number; // engagement_rate / baseline
  verdict: "winner" | "underperformer";
  // Cached explainer if we already generated one (JSON shape matches ExplainerCard).
  explainer: unknown;
}

interface RawPostRow {
  id: string;
  text: string;
  theme: string | null;
  channel: Channel;
  posted_at: string | null;
  explainer: unknown;
  post_metrics: Array<{ engagement_rate: number | null; fetched_at: string }>;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function latestEngagement(row: RawPostRow): number | null {
  if (!row.post_metrics || row.post_metrics.length === 0) return null;
  const latest = row.post_metrics
    .slice()
    .sort((a, b) => +new Date(b.fetched_at) - +new Date(a.fetched_at))[0];
  return latest?.engagement_rate ?? null;
}

export interface FindOutliersOptions {
  // Cap how many outlier rows we return (the dashboard wants 2; post-detail
  // wants 1 for a specific post). Default 10 to give the caller room to
  // dedupe.
  limit?: number;
  // When set, only return outlier(s) for this specific post_id. Used by the
  // post-detail view.
  postId?: string;
}

export interface OutlierContext {
  baseline: number;
  sampleSize: number;
}

// Returns the workspace baseline + the outlier set in one shot. Returns
// { baseline: 0, ... outliers: [] } when there isn't enough signal yet.
export async function findOutliers(
  workspaceId: string,
  opts: FindOutliersOptions = {},
): Promise<{ context: OutlierContext; outliers: OutlierPost[] }> {
  const svc = supabaseService();
  const since = new Date(Date.now() - BASELINE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const ageCutoff = new Date(Date.now() - AGE_GATE_HOURS * 60 * 60 * 1000).toISOString();

  let query = svc
    .from("posts")
    .select("id, text, theme, channel, posted_at, explainer, post_metrics(engagement_rate, fetched_at)")
    .eq("workspace_id", workspaceId)
    .eq("status", "posted")
    .gte("posted_at", since);

  if (opts.postId) {
    query = query.eq("id", opts.postId);
  }

  const { data, error } = await query;
  if (error || !data) {
    return { context: { baseline: 0, sampleSize: 0 }, outliers: [] };
  }

  const rows = data as unknown as RawPostRow[];

  // Pool all engagement_rates from the lookback window for the baseline.
  // (We *don't* exclude the post under test — for a 28d window with even a
  // few dozen posts, one row's contribution to the median is negligible.)
  const engagementSeries: number[] = [];
  for (const row of rows) {
    const rate = latestEngagement(row);
    if (rate != null) engagementSeries.push(rate);
  }

  // Not enough signal yet. Bail rather than calling everything an outlier.
  if (engagementSeries.length < BASELINE_MIN_SAMPLE) {
    return {
      context: { baseline: 0, sampleSize: engagementSeries.length },
      outliers: [],
    };
  }

  const baseline = median(engagementSeries);

  // Edge case: if baseline is 0 (whole workspace has zero engagement), we
  // can't compute ratios meaningfully. Return empty rather than dividing.
  if (baseline <= 0) {
    return {
      context: { baseline: 0, sampleSize: engagementSeries.length },
      outliers: [],
    };
  }

  const outliers: OutlierPost[] = [];
  for (const row of rows) {
    if (!row.posted_at) continue;
    if (row.posted_at > ageCutoff) continue; // too fresh, metrics still settling
    const rate = latestEngagement(row);
    if (rate == null) continue;
    const ratio = rate / baseline;
    let verdict: "winner" | "underperformer" | null = null;
    if (ratio >= WINNER_MULTIPLIER) verdict = "winner";
    else if (ratio <= LOSER_MULTIPLIER) verdict = "underperformer";
    if (!verdict) continue;
    outliers.push({
      id: row.id,
      text: row.text,
      theme: row.theme,
      channel: row.channel,
      posted_at: row.posted_at,
      engagement_rate: rate,
      baseline,
      ratio,
      verdict,
      explainer: row.explainer,
    });
  }

  // Sort by extremity (furthest from baseline first), then most recent. The
  // dashboard slices the top N from here; we want the most informative
  // outliers shown.
  outliers.sort((a, b) => {
    const extA = Math.abs(Math.log(a.ratio));
    const extB = Math.abs(Math.log(b.ratio));
    if (extB !== extA) return extB - extA;
    return +new Date(b.posted_at) - +new Date(a.posted_at);
  });

  const limit = opts.limit ?? 10;
  return {
    context: { baseline, sampleSize: engagementSeries.length },
    outliers: outliers.slice(0, limit),
  };
}

// Helper for the dashboard "give me at most N cards" path.
export async function findDashboardOutliers(
  workspaceId: string,
  limit: number,
): Promise<{ context: OutlierContext; outliers: OutlierPost[] }> {
  return findOutliers(workspaceId, { limit });
}
