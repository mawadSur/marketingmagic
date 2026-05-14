// Phase 6.5 — Industry-baseline engagement rates per channel × day-of-week ×
// 2-hour-window. Used as the Bayesian prior when a workspace has thin data.
//
// Source heuristics (averaged across Sprout Social 2024, Hootsuite 2024,
// Later 2023 best-time-to-post studies — all publicly published industry
// reports). Values are deliberately compressed into a low absolute band
// (0.005 – 0.045 engagement rate) because the prior should *bias* toward
// known good windows, not dominate observed workspace data.
//
// Day index follows JS `Date.getDay()`: 0=Sun, 1=Mon, … 6=Sat.
// hourBucket is the START of a 2-hour window: 0, 2, 4, … 22.
//
// Empty days/hours fall back to BASELINE_FLOOR.

import type { TimeWindow } from "./schema";

export const BASELINE_FLOOR = 0.005;

type BaselineMap = Partial<Record<number, Partial<Record<number, number>>>>;

// X / Twitter
// Sprout 2024: weekday business hours dominate, esp. Tue-Thu 9am-3pm.
// Mon morning + Fri midday strong; weekends weak except sports/entertainment.
const X_BASELINE: BaselineMap = {
  1: { 8: 0.020, 10: 0.025, 12: 0.028, 14: 0.026, 16: 0.018, 18: 0.012 }, // Mon
  2: { 8: 0.024, 10: 0.032, 12: 0.038, 14: 0.034, 16: 0.024, 18: 0.014 }, // Tue
  3: { 8: 0.024, 10: 0.033, 12: 0.038, 14: 0.035, 16: 0.024, 18: 0.014 }, // Wed
  4: { 8: 0.022, 10: 0.030, 12: 0.034, 14: 0.030, 16: 0.022, 18: 0.012 }, // Thu
  5: { 8: 0.018, 10: 0.022, 12: 0.024, 14: 0.018, 16: 0.012, 18: 0.008 }, // Fri
  6: { 10: 0.010, 12: 0.012, 14: 0.011, 16: 0.009 },                       // Sat
  0: { 10: 0.011, 12: 0.013, 14: 0.012, 16: 0.010 },                       // Sun
};

// LinkedIn
// Sprout/Hootsuite 2024: Tue-Thu 10am-1pm peak; pre-work 7-8am also strong.
// Weekends and evenings are dead zones for professional content.
const LINKEDIN_BASELINE: BaselineMap = {
  1: { 8: 0.020, 10: 0.026, 12: 0.024, 14: 0.022 },
  2: { 8: 0.028, 10: 0.038, 12: 0.034, 14: 0.030 },
  3: { 8: 0.030, 10: 0.040, 12: 0.038, 14: 0.032 },
  4: { 8: 0.028, 10: 0.038, 12: 0.034, 14: 0.030 },
  5: { 8: 0.020, 10: 0.024, 12: 0.020 },
  6: {},
  0: {},
};

// Threads
// Limited public data — Meta's own dashboards plus Later 2023 mirror IG's
// pattern but skewed slightly later (more conversation-driven evening use).
const THREADS_BASELINE: BaselineMap = {
  1: { 12: 0.030, 14: 0.032, 16: 0.028, 18: 0.024, 20: 0.020 },
  2: { 12: 0.034, 14: 0.038, 16: 0.034, 18: 0.028, 20: 0.022 },
  3: { 12: 0.038, 14: 0.040, 16: 0.036, 18: 0.030, 20: 0.024 },
  4: { 12: 0.034, 14: 0.036, 16: 0.032, 18: 0.026, 20: 0.020 },
  5: { 12: 0.024, 14: 0.022, 16: 0.018 },
  6: { 12: 0.014, 14: 0.014, 16: 0.012 },
  0: { 12: 0.016, 14: 0.018, 16: 0.014 },
};

// Instagram
// Later 2023 + Hootsuite 2024: Tue-Fri mid-morning + early evening sweet spot.
// Sunday is a hidden strong day for personal/lifestyle accounts.
const INSTAGRAM_BASELINE: BaselineMap = {
  1: { 10: 0.034, 12: 0.030, 14: 0.026, 18: 0.030, 20: 0.024 },
  2: { 10: 0.040, 12: 0.034, 14: 0.030, 18: 0.034, 20: 0.026 },
  3: { 10: 0.042, 12: 0.036, 14: 0.030, 18: 0.034, 20: 0.026 },
  4: { 10: 0.040, 12: 0.034, 14: 0.030, 18: 0.034, 20: 0.026 },
  5: { 10: 0.032, 12: 0.024, 14: 0.020 },
  6: { 10: 0.020, 12: 0.020, 14: 0.018 },
  0: { 10: 0.028, 12: 0.028, 14: 0.024, 18: 0.020 },
};

// Bluesky
// No published study yet; audience overlaps with early-adopter / tech-X users.
// Mirror X's profile but slightly weaker evenings (community is smaller).
const BLUESKY_BASELINE: BaselineMap = {
  1: { 8: 0.018, 10: 0.022, 12: 0.024, 14: 0.022, 16: 0.016 },
  2: { 8: 0.022, 10: 0.028, 12: 0.032, 14: 0.030, 16: 0.022 },
  3: { 8: 0.022, 10: 0.030, 12: 0.034, 14: 0.030, 16: 0.022 },
  4: { 8: 0.020, 10: 0.026, 12: 0.028, 14: 0.026, 16: 0.018 },
  5: { 8: 0.016, 10: 0.018, 12: 0.018 },
  6: { 10: 0.008, 12: 0.010, 14: 0.010 },
  0: { 10: 0.009, 12: 0.010, 14: 0.010 },
};

// Facebook (registered in types but not in CHANNELS yet; included for parity
// in case it lands — defaults to a Threads-like prior).
const FACEBOOK_BASELINE: BaselineMap = THREADS_BASELINE;

const BASELINES: Record<string, BaselineMap> = {
  x: X_BASELINE,
  linkedin: LINKEDIN_BASELINE,
  threads: THREADS_BASELINE,
  instagram: INSTAGRAM_BASELINE,
  bluesky: BLUESKY_BASELINE,
  facebook: FACEBOOK_BASELINE,
};

export function baselineRate(channel: string, dayOfWeek: number, hourBucket: number): number {
  const map = BASELINES[channel];
  if (!map) return BASELINE_FLOOR;
  const day = map[dayOfWeek];
  if (!day) return BASELINE_FLOOR;
  return day[hourBucket] ?? BASELINE_FLOOR;
}

// 7 days × 12 2-hour buckets = 84 cells. Used to seed the engagement grid.
export const ALL_HOUR_BUCKETS = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22] as const;
export const ALL_DAYS_OF_WEEK = [0, 1, 2, 3, 4, 5, 6] as const;

export function baselineGrid(channel: string): TimeWindow[] {
  const out: TimeWindow[] = [];
  for (const day of ALL_DAYS_OF_WEEK) {
    for (const hour of ALL_HOUR_BUCKETS) {
      out.push({
        dayOfWeek: day,
        hourBucket: hour,
        engagementRate: baselineRate(channel, day, hour),
        confidence: "low",
        sampleSize: 0,
        isBaseline: true,
      });
    }
  }
  return out;
}

// Document the sources for the summary. Update when refreshing the data set.
export const BASELINE_SOURCES = {
  x: "Sprout Social 2024 best-time-to-post; Hootsuite 2024 (weekday business-hour peaks).",
  linkedin: "Hootsuite + Sprout 2024 (Tue-Thu 10am-1pm; pre-work spike at 7-8am).",
  threads: "Meta first-party 2024 + Later 2023 (IG-like with later-evening skew).",
  instagram: "Later 2023 + Hootsuite 2024 (Tue-Fri 10am + 6-8pm).",
  bluesky: "No public study; modelled as X with weaker evenings (early-adopter tech audience).",
  facebook: "Reused Threads heuristic (Meta surface, similar conversational pattern).",
} as const;
