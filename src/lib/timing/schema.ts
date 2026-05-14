// Phase 6.5 — Smart Timing types.
//
// A TimeWindow is one (dayOfWeek, hourBucket) cell in the engagement heatmap.
// hourBucket is the START of a 2-hour window — i.e. 0, 2, 4, … 22.
// dayOfWeek follows JS convention (0=Sun, 1=Mon … 6=Sat) so we can hand it
// straight to `new Date().getDay()` without conversion gymnastics.

export type Confidence = "high" | "medium" | "low";

export interface TimeWindow {
  // 0=Sun … 6=Sat. JS `Date.getDay()` convention.
  dayOfWeek: number;
  // 0, 2, 4, … 22. Start hour of a 2-hour window.
  hourBucket: number;
  // Smoothed engagement rate for this slot (0…1).
  engagementRate: number;
  // Confidence based on sample size: high (≥10 posts), medium (3–9), low (<3).
  confidence: Confidence;
  // Number of historical posts that landed in this slot in the analysis window.
  sampleSize: number;
  // True when the slot was filled by industry baseline (sampleSize === 0).
  // Useful for the UI to dim baseline-only cells.
  isBaseline: boolean;
}

export interface OptimalWindowsResult {
  // Top N windows sorted by engagementRate desc.
  top: TimeWindow[];
  // Full 7×12 grid (84 cells) — for heatmap rendering. Always present even
  // when the workspace has zero historical data (filled from baselines).
  grid: TimeWindow[];
  // The channel this analysis was run for.
  channel: string;
  // IANA timezone the buckets are expressed in. Defaults to "UTC".
  timezone: string;
  // Total posts considered for this channel (post-decay-weighted count for
  // confidence labelling; the raw count is in `rawSampleCount`).
  totalSamples: number;
  rawSampleCount: number;
}

// One row of the post-timing explainer: "Posted at <time> — your peak window
// is +X% over your typical slot." Used by post-timing-explainer.tsx.
export interface PostTimingExplain {
  postedAtIso: string;
  postedHourBucket: number;
  postedDayOfWeek: number;
  postedSlotRate: number;
  workspaceAverageRate: number;
  // Engagement-lift ratio: postedSlotRate / workspaceAverageRate. > 1 = better.
  liftRatio: number;
  // The single best slot the workspace has, for comparison.
  bestSlot: { dayOfWeek: number; hourBucket: number; engagementRate: number } | null;
  // High/medium/low confidence in the slot estimate (derived from sample size).
  confidence: Confidence;
  isBaseline: boolean;
  timezone: string;
}
