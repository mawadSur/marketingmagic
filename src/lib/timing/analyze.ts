// Phase 6.5 — Per-channel optimal posting windows.
//
// `getOptimalWindows(workspaceId, channel)` returns the top N (default 5) time
// windows for a channel based on the workspace's last 90 days of post_metrics.
// Sparse cells fall back to a Bayesian-smoothed estimate that combines the
// observed engagement rate with an industry baseline prior.
//
// Smoothing formula:
//     smoothed = (Σ w_i · r_i + priorWeight · baseline) / (Σ w_i + priorWeight)
//
//   w_i        = exponential time-decay weight per observation (decay.ts).
//   r_i        = observed engagement_rate for that post.
//   priorWeight = 5 (chosen empirically — large enough to absorb 1–2 noisy
//                  observations, small enough that 10+ real posts dominate).
//
// Confidence buckets, based on raw sample count in the cell:
//   high   ≥ 10 posts
//   medium 3 – 9 posts
//   low    < 3 posts (mostly prior-driven)
//
// Timezone: posts are bucketed in the workspace's `audience_timezone` (from
// brand_briefs). When that's unset we use UTC.

import { supabaseService } from "@/lib/supabase/service";
import type { Channel } from "@/lib/db/types";
import { decayWeightFor } from "./decay";
import {
  ALL_DAYS_OF_WEEK,
  ALL_HOUR_BUCKETS,
  baselineGrid,
  baselineRate,
} from "./baselines";
import type {
  Confidence,
  OptimalWindowsResult,
  PostTimingExplain,
  TimeWindow,
} from "./schema";

const ANALYSIS_WINDOW_DAYS = 90;
const PRIOR_WEIGHT = 5;
const TOP_N = 5;

export const TIMING_PRIOR_WEIGHT = PRIOR_WEIGHT;
export const TIMING_ANALYSIS_WINDOW_DAYS = ANALYSIS_WINDOW_DAYS;

interface PostObservation {
  postedAt: string;       // iso
  engagementRate: number; // 0..1
}

// Bucket cell key = `${dayOfWeek}-${hourBucket}`.
function cellKey(dayOfWeek: number, hourBucket: number): string {
  return `${dayOfWeek}-${hourBucket}`;
}

function confidenceFor(sampleSize: number): Confidence {
  if (sampleSize >= 10) return "high";
  if (sampleSize >= 3) return "medium";
  return "low";
}

// Cross-runtime helper: returns the local hour and day-of-week of `iso` in
// the given IANA `timezone`. Falls back to UTC if Intl rejects the zone.
function hourAndDayInTz(iso: string, timezone: string): { day: number; hour: number } | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      weekday: "short",
      hour: "2-digit",
    }).formatToParts(date);
  } catch {
    try {
      parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        hour12: false,
        weekday: "short",
        hour: "2-digit",
      }).formatToParts(date);
    } catch {
      return null;
    }
  }

  const hourStr = parts.find((p) => p.type === "hour")?.value ?? "0";
  const weekdayStr = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  const hour = Number.parseInt(hourStr, 10);
  // Intl produces "24" for midnight on some runtimes — normalise to 0.
  const normHour = Number.isFinite(hour) ? hour % 24 : 0;
  const dayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const day = dayMap[weekdayStr] ?? 0;
  return { day, hour: normHour };
}

function bucketHour(hour: number): number {
  // Floor to nearest even hour: 0,2,4,…,22.
  return Math.floor(hour / 2) * 2;
}

async function fetchAudienceTimezone(workspaceId: string): Promise<string> {
  const svc = supabaseService();
  // Untyped select — the `audience_timezone` column lives in migration 012
  // which the DB will have after deploy. If the column is missing (running
  // against an older DB), we silently fall back to UTC.
  const { data, error } = await svc
    .from("brand_briefs")
    .select("audience_timezone")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error || !data) return "UTC";
  const tz = (data as { audience_timezone?: string | null }).audience_timezone;
  return tz ?? "UTC";
}

async function fetchObservations(
  workspaceId: string,
  channel: string,
): Promise<PostObservation[]> {
  const svc = supabaseService();
  const since = new Date(Date.now() - ANALYSIS_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // post_metrics holds repeated samples per post. We want the latest
  // engagement_rate per post in the window. Pulling fetched_at desc and
  // deduping in code mirrors the existing dashboard analytics pattern
  // (Supabase doesn't expose DISTINCT ON cleanly).
  const { data } = await svc
    .from("post_metrics")
    .select(
      "post_id, engagement_rate, fetched_at, posts!inner(workspace_id, channel, posted_at, status)",
    )
    .eq("posts.workspace_id", workspaceId)
    .eq("posts.channel", channel as Channel)
    .eq("posts.status", "posted")
    .gte("posts.posted_at", since)
    .order("fetched_at", { ascending: false })
    .limit(2000);

  type Row = {
    post_id: string;
    engagement_rate: number | null;
    posts: { posted_at: string | null } | null;
  };

  const seen = new Set<string>();
  const out: PostObservation[] = [];
  for (const row of ((data ?? []) as unknown as Row[])) {
    if (seen.has(row.post_id)) continue;
    seen.add(row.post_id);
    const postedAt = row.posts?.posted_at;
    if (!postedAt || row.engagement_rate == null) continue;
    if (!Number.isFinite(row.engagement_rate)) continue;
    out.push({ postedAt, engagementRate: row.engagement_rate });
  }
  return out;
}

export async function getOptimalWindows(
  workspaceId: string,
  channel: string,
  options: { topN?: number } = {},
): Promise<OptimalWindowsResult> {
  const topN = options.topN ?? TOP_N;
  const [timezone, observations] = await Promise.all([
    fetchAudienceTimezone(workspaceId),
    fetchObservations(workspaceId, channel),
  ]);
  return computeOptimalWindows({
    channel,
    timezone,
    observations,
    topN,
  });
}

// Pure-function core, surfaced for unit testing and for the explainer
// (which wants to reuse the same grid math given pre-loaded observations).
export function computeOptimalWindows(args: {
  channel: string;
  timezone: string;
  observations: PostObservation[];
  topN?: number;
  now?: Date;
}): OptimalWindowsResult {
  const { channel, timezone, observations } = args;
  const now = args.now ?? new Date();
  const topN = args.topN ?? TOP_N;

  // Accumulate Σw·r and Σw per cell, plus raw counts.
  const cells = new Map<
    string,
    { dayOfWeek: number; hourBucket: number; weightSum: number; weightedRate: number; count: number }
  >();
  let totalWeighted = 0;
  let rawCount = 0;

  for (const obs of observations) {
    const place = hourAndDayInTz(obs.postedAt, timezone);
    if (!place) continue;
    const day = place.day;
    const hour = bucketHour(place.hour);
    const w = decayWeightFor(obs.postedAt, now);
    if (w <= 0) continue;
    const key = cellKey(day, hour);
    const cur = cells.get(key) ?? { dayOfWeek: day, hourBucket: hour, weightSum: 0, weightedRate: 0, count: 0 };
    cur.weightSum += w;
    cur.weightedRate += w * obs.engagementRate;
    cur.count += 1;
    cells.set(key, cur);
    totalWeighted += w;
    rawCount += 1;
  }

  // Build the full 84-cell grid: observed cells get the smoothed mean,
  // empty cells get the baseline directly (and are flagged isBaseline).
  const grid: TimeWindow[] = [];
  for (const day of ALL_DAYS_OF_WEEK) {
    for (const hour of ALL_HOUR_BUCKETS) {
      const key = cellKey(day, hour);
      const cell = cells.get(key);
      const baseline = baselineRate(channel, day, hour);
      if (!cell) {
        grid.push({
          dayOfWeek: day,
          hourBucket: hour,
          engagementRate: baseline,
          confidence: "low",
          sampleSize: 0,
          isBaseline: true,
        });
        continue;
      }
      const smoothed =
        (cell.weightedRate + PRIOR_WEIGHT * baseline) /
        (cell.weightSum + PRIOR_WEIGHT);
      grid.push({
        dayOfWeek: day,
        hourBucket: hour,
        engagementRate: smoothed,
        confidence: confidenceFor(cell.count),
        sampleSize: cell.count,
        isBaseline: false,
      });
    }
  }

  // Top N: sort the whole grid by engagementRate desc, then return slice.
  const top = [...grid].sort((a, b) => b.engagementRate - a.engagementRate).slice(0, topN);

  return {
    top,
    grid,
    channel,
    timezone,
    totalSamples: totalWeighted,
    rawSampleCount: rawCount,
  };
}

// Returns the next-future ISO timestamp that falls in a top-K slot for the
// given channel. Used by the dashboard widget's "Next optimal slot" hint and
// (deferred) by the plan generator's `suggested_scheduled_at` defaulting.
export function nextOptimalSlotIso(
  result: OptimalWindowsResult,
  options: { from?: Date; horizonDays?: number; topK?: number } = {},
): string | null {
  const from = options.from ?? new Date();
  const horizonDays = options.horizonDays ?? 7;
  const topK = options.topK ?? 5;
  const allowedKeys = new Set(
    [...result.top].slice(0, topK).map((t) => cellKey(t.dayOfWeek, t.hourBucket)),
  );
  if (allowedKeys.size === 0) return null;

  // Walk forward hour-by-hour. We do this in the workspace's audience TZ so
  // the slot match is in the right frame.
  const horizonMs = horizonDays * 24 * 60 * 60 * 1000;
  const stepMs = 60 * 60 * 1000; // 1h granularity is fine — buckets are 2h.
  for (let t = from.getTime(); t < from.getTime() + horizonMs; t += stepMs) {
    const iso = new Date(t).toISOString();
    const place = hourAndDayInTz(iso, result.timezone);
    if (!place) continue;
    const key = cellKey(place.day, bucketHour(place.hour));
    if (allowedKeys.has(key)) return iso;
  }
  return null;
}

// Explains how a single post's scheduled/posted time stacks up against the
// workspace's per-slot history. Surfaced in the post-timing-explainer UI.
export async function explainPostTiming(
  workspaceId: string,
  channel: string,
  postedAtIso: string,
): Promise<PostTimingExplain | null> {
  const [timezone, observations] = await Promise.all([
    fetchAudienceTimezone(workspaceId),
    fetchObservations(workspaceId, channel),
  ]);
  const grid = computeOptimalWindows({ channel, timezone, observations });
  const place = hourAndDayInTz(postedAtIso, timezone);
  if (!place) return null;
  const hour = bucketHour(place.hour);
  const cell = grid.grid.find((g) => g.dayOfWeek === place.day && g.hourBucket === hour);
  if (!cell) return null;

  // Workspace average = mean engagement rate across all observed cells.
  // We deliberately exclude baseline-only cells so the average doesn't drag
  // toward the prior when the workspace has little data.
  const observedCells = grid.grid.filter((g) => !g.isBaseline);
  const workspaceAverageRate = observedCells.length
    ? observedCells.reduce((acc, c) => acc + c.engagementRate, 0) / observedCells.length
    : grid.grid.reduce((acc, c) => acc + c.engagementRate, 0) / grid.grid.length;

  const best = grid.top[0] ?? null;
  const liftRatio =
    workspaceAverageRate > 0 ? cell.engagementRate / workspaceAverageRate : 1;

  return {
    postedAtIso,
    postedHourBucket: hour,
    postedDayOfWeek: place.day,
    postedSlotRate: cell.engagementRate,
    workspaceAverageRate,
    liftRatio,
    bestSlot: best
      ? {
          dayOfWeek: best.dayOfWeek,
          hourBucket: best.hourBucket,
          engagementRate: best.engagementRate,
        }
      : null,
    confidence: cell.confidence,
    isBaseline: cell.isBaseline,
    timezone,
  };
}

// Re-export so callers don't need to import the grid baseline directly.
export { baselineGrid };
