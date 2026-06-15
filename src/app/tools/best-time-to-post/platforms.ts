// Data shaping for the public "best time to post" tool (acquisition Lever 3).
//
// PURE DATA — no LLM, no DB, no auth. Everything here is derived from the
// static industry-baseline engagement grid in src/lib/timing/baselines.ts
// (the same prior the in-app smart-timing widget uses). We expose a small,
// read-only view of it so a public, statically-rendered page can answer
// "what's the best time to post on <platform>?" and rank for that search term.
//
// We deliberately only list platforms that HAVE a real baseline map. TikTok is
// in the channel registry but has no baseline entry (it would render a flat,
// floor-filled heatmap), so it's omitted here — every page must be data-backed.

import {
  ALL_DAYS_OF_WEEK,
  ALL_HOUR_BUCKETS,
  baselineGrid,
  BASELINE_SOURCES,
} from "@/lib/timing/baselines";
import type { TimeWindow } from "@/lib/timing/schema";

export const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export const DAY_LABELS_LONG = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
export const HOUR_BUCKETS = ALL_HOUR_BUCKETS;
export const DAYS_OF_WEEK = ALL_DAYS_OF_WEEK;

// One public platform entry. `slug` is the URL segment + the baselines key.
export interface ToolPlatform {
  // URL slug AND the key into the baseline grid (e.g. "instagram").
  slug: string;
  // Display name ("Instagram").
  label: string;
  // One-line, data-grounded summary of the platform's posting rhythm.
  blurb: string;
}

// The platforms we publish a page for — ordered by search volume / relevance.
// Each `slug` MUST be a key with a real baseline map in baselines.ts.
export const TOOL_PLATFORMS: ToolPlatform[] = [
  {
    slug: "instagram",
    label: "Instagram",
    blurb:
      "Mid-morning and early-evening on weekdays, with a hidden lift on Sunday for lifestyle accounts.",
  },
  {
    slug: "linkedin",
    label: "LinkedIn",
    blurb:
      "A tight Tuesday–Thursday late-morning window — professional content dies on evenings and weekends.",
  },
  {
    slug: "x",
    label: "X (Twitter)",
    blurb:
      "Weekday business hours rule, peaking Tuesday–Thursday around midday; weekends run quiet.",
  },
  {
    slug: "youtube",
    label: "YouTube",
    blurb:
      "Long-form wins weekend and weekday mornings; Shorts peak Friday afternoon — we blend both.",
  },
  {
    slug: "threads",
    label: "Threads",
    blurb:
      "An Instagram-like rhythm skewed later into the evening, when the conversation picks up.",
  },
  {
    slug: "facebook",
    label: "Facebook",
    blurb:
      "Weekday mid-morning through mid-afternoon, with Monday a surprisingly strong opener.",
  },
  {
    slug: "bluesky",
    label: "Bluesky",
    blurb:
      "Tracks X's weekday-midday shape with a smaller, more tech-leaning early-adopter audience.",
  },
];

export function getToolPlatform(slug: string): ToolPlatform | undefined {
  return TOOL_PLATFORMS.find((p) => p.slug === slug);
}

// A ranked "best slot" with human-readable labels, derived from the baseline.
export interface BestSlot {
  dayOfWeek: number;
  hourBucket: number;
  engagementRate: number;
  dayLabel: string;
  dayLabelLong: string;
  // "10:00 AM – 12:00 PM"
  timeLabel: string;
}

// Format a 0–22 hour bucket as a 2-hour 12h-clock window: "10:00 AM – 12:00 PM".
export function formatWindow(hourBucket: number): string {
  return `${formatHour(hourBucket)} – ${formatHour((hourBucket + 2) % 24)}`;
}

function formatHour(hour24: number): string {
  const period = hour24 < 12 ? "AM" : "PM";
  const h12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${h12}:00 ${period}`;
}

// The full 7×12 baseline grid for a platform (84 cells) — for the heatmap.
export function platformGrid(slug: string): TimeWindow[] {
  return baselineGrid(slug);
}

// The top N windows for a platform, sorted by baseline engagement rate desc,
// with display labels attached. Ties are broken by earlier day then hour so the
// ordering is deterministic across builds (important for static rendering).
export function topSlots(slug: string, n = 5): BestSlot[] {
  return platformGrid(slug)
    .filter((w) => !isFloor(w.engagementRate))
    .slice()
    .sort(
      (a, b) =>
        b.engagementRate - a.engagementRate ||
        a.dayOfWeek - b.dayOfWeek ||
        a.hourBucket - b.hourBucket,
    )
    .slice(0, n)
    .map((w) => ({
      dayOfWeek: w.dayOfWeek,
      hourBucket: w.hourBucket,
      engagementRate: w.engagementRate,
      dayLabel: DAY_LABELS[w.dayOfWeek] ?? "",
      dayLabelLong: DAY_LABELS_LONG[w.dayOfWeek] ?? "",
      timeLabel: formatWindow(w.hourBucket),
    }));
}

// The maximum baseline rate in the grid — used to normalise heatmap intensity.
export function maxRate(slug: string): number {
  return Math.max(...platformGrid(slug).map((w) => w.engagementRate), 0.0001);
}

// The published industry source string for a platform (footnote / E-E-A-T).
export function sourceFor(slug: string): string {
  return (BASELINE_SOURCES as Record<string, string | undefined>)[slug] ?? "";
}

// The baseline floor marks "no signal" cells. We treat anything at/below it as
// not a real recommendation (keeps the floor band out of the top-slots list).
function isFloor(rate: number): boolean {
  return rate <= 0.0055;
}
