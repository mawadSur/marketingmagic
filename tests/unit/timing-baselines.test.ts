import { describe, it, expect } from "vitest";

// ── Unit: industry-baseline engagement priors (src/lib/timing/baselines.ts) ──
//
// These priors feed the dashboard "Best windows" heatmap via getOptimalWindows.
// The focus here is the YouTube prior added 2026-06-11 — before it, YouTube had
// NO entry, so baselineRate("youtube", …) returned BASELINE_FLOOR for all 84
// cells and the heatmap rendered as a flat, dead grid. These tests prove the
// grid now has real structure (a discernible Friday-afternoon peak) and stays
// inside the documented prior band.

import {
  BASELINE_FLOOR,
  BASELINE_SOURCES,
  baselineGrid,
  baselineRate,
} from "@/lib/timing/baselines";

describe("YouTube engagement baseline", () => {
  it("is registered (heatmap is no longer a flat BASELINE_FLOOR grid)", () => {
    const grid = baselineGrid("youtube");
    const aboveFloor = grid.filter((c) => c.engagementRate > BASELINE_FLOOR);
    // The bug being fixed: a missing channel → every cell == BASELINE_FLOOR.
    expect(aboveFloor.length).toBeGreaterThan(40);
    expect(BASELINE_SOURCES).toHaveProperty("youtube");
  });

  it("stays within the documented 0.005–0.045 prior band", () => {
    for (const cell of baselineGrid("youtube")) {
      expect(cell.engagementRate).toBeGreaterThanOrEqual(BASELINE_FLOOR);
      expect(cell.engagementRate).toBeLessThanOrEqual(0.045);
    }
  });

  it("peaks Friday afternoon (Fri 16:00 = the standout Shorts slot)", () => {
    // JS getDay(): 5 = Friday. hourBucket 16 = the 4-6pm window.
    const friAfternoon = baselineRate("youtube", 5, 16);
    // Highest single cell in the whole grid per Buffer + SocialPilot.
    const all = baselineGrid("youtube").map((c) => c.engagementRate);
    expect(friAfternoon).toBe(Math.max(...all));
  });

  it("treats pre-dawn and late-night as weak (pre-6am / post-10pm)", () => {
    // 4am Monday and midnight Wednesday should fall back to the floor.
    expect(baselineRate("youtube", 1, 4)).toBe(BASELINE_FLOOR);
    expect(baselineRate("youtube", 3, 0)).toBe(BASELINE_FLOOR);
  });

  it("rewards Sunday morning (long-form's best window) above Sunday late-night", () => {
    expect(baselineRate("youtube", 0, 10)).toBeGreaterThan(baselineRate("youtube", 0, 22));
  });

  it("falls back to BASELINE_FLOOR for an unknown channel", () => {
    expect(baselineRate("myspace", 3, 12)).toBe(BASELINE_FLOOR);
  });
});
