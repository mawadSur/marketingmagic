import { describe, expect, it } from "vitest";

import {
  type DraftClip,
  MIN_CLIP_MS,
  clampMs,
  clipDurationMs,
  draftsToSpecs,
  formatClock,
  isValidRange,
  slugifyLabel,
} from "../../src/app/(app)/video/upload/[id]/clip-math";

// ── Unit: clip-editor range math (slice E, clip-math.ts) ─────────────────────
//
// Pure helpers behind the timeline UI: clamping ms into the source window,
// validating cut ranges, slugifying labels into fs-safe output filenames, and
// projecting editable drafts into the ClipSpec[] sent to the orchestrator.

const draft = (over: Partial<DraftClip> = {}): DraftClip => ({
  id: "d1",
  label: "My Clip",
  startMs: 1_000,
  endMs: 6_000,
  burnCaptions: false,
  ...over,
});

describe("clampMs", () => {
  it("clamps into [0, max] and rounds", () => {
    expect(clampMs(-50, 10_000)).toBe(0);
    expect(clampMs(12_000, 10_000)).toBe(10_000);
    expect(clampMs(3_333.7, 10_000)).toBe(3_334);
  });

  it("treats NaN/Infinity as 0", () => {
    expect(clampMs(NaN, 10_000)).toBe(0);
    expect(clampMs(Infinity, 10_000)).toBe(10_000);
  });
});

describe("clipDurationMs", () => {
  it("is end - start, never negative", () => {
    expect(clipDurationMs({ startMs: 1_000, endMs: 4_500 })).toBe(3_500);
    expect(clipDurationMs({ startMs: 5_000, endMs: 1_000 })).toBe(0);
  });
});

describe("isValidRange", () => {
  it("accepts a well-formed in-bounds range", () => {
    expect(isValidRange({ startMs: 1_000, endMs: 6_000 }, 30_000)).toBe(true);
  });

  it("rejects start >= end", () => {
    expect(isValidRange({ startMs: 6_000, endMs: 6_000 }, 30_000)).toBe(false);
    expect(isValidRange({ startMs: 7_000, endMs: 6_000 }, 30_000)).toBe(false);
  });

  it("rejects sub-minimum clips", () => {
    expect(isValidRange({ startMs: 0, endMs: MIN_CLIP_MS - 1 }, 30_000)).toBe(false);
    expect(isValidRange({ startMs: 0, endMs: MIN_CLIP_MS }, 30_000)).toBe(true);
  });

  it("rejects an end past the source duration (with 1ms tolerance)", () => {
    expect(isValidRange({ startMs: 1_000, endMs: 31_000 }, 30_000)).toBe(false);
    expect(isValidRange({ startMs: 1_000, endMs: 30_000 }, 30_000)).toBe(true);
  });

  it("skips the bounds check when duration is unknown (0)", () => {
    expect(isValidRange({ startMs: 1_000, endMs: 99_000 }, 0)).toBe(true);
  });

  it("rejects non-finite edges", () => {
    expect(isValidRange({ startMs: NaN, endMs: 6_000 }, 30_000)).toBe(false);
    expect(isValidRange({ startMs: 0, endMs: Infinity }, 30_000)).toBe(false);
  });
});

describe("slugifyLabel", () => {
  it("lowercases, collapses non-alnum to single dashes, trims", () => {
    expect(slugifyLabel("  My Great Clip!! ", 0)).toBe("my-great-clip");
    expect(slugifyLabel("A___B  C", 0)).toBe("a-b-c");
  });

  it("falls back to clip-<n+1> for empty/all-punctuation input", () => {
    expect(slugifyLabel("", 0)).toBe("clip-1");
    expect(slugifyLabel("***", 4)).toBe("clip-5");
    expect(slugifyLabel("   ", 1)).toBe("clip-2");
  });

  it("caps length and never leaves a trailing dash", () => {
    const out = slugifyLabel("x".repeat(80), 0);
    expect(out.length).toBeLessThanOrEqual(48);
    expect(out.endsWith("-")).toBe(false);
  });

  it("strips diacritics", () => {
    expect(slugifyLabel("Café Résumé", 0)).toBe("cafe-resume");
  });
});

describe("formatClock", () => {
  it("formats M:SS under an hour", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(5_000)).toBe("0:05");
    expect(formatClock(65_000)).toBe("1:05");
    expect(formatClock(125_000)).toBe("2:05");
  });

  it("formats H:MM:SS past an hour", () => {
    expect(formatClock(3_725_000)).toBe("1:02:05");
  });

  it("guards negatives/NaN", () => {
    expect(formatClock(-1_000)).toBe("0:00");
    expect(formatClock(NaN)).toBe("0:00");
  });
});

describe("draftsToSpecs", () => {
  it("drops invalid ranges and slugs labels", () => {
    const specs = draftsToSpecs(
      [
        draft({ id: "a", label: "First Clip", startMs: 0, endMs: 5_000 }),
        draft({ id: "b", label: "too short", startMs: 0, endMs: 100 }), // < MIN
      ],
      30_000,
    );
    expect(specs).toHaveLength(1);
    expect(specs[0]).toEqual({ label: "first-clip", startMs: 0, endMs: 5_000, burnCaptions: false });
  });

  it("de-dupes colliding output labels", () => {
    const specs = draftsToSpecs(
      [
        draft({ id: "a", label: "Hook", startMs: 0, endMs: 5_000 }),
        draft({ id: "b", label: "hook!", startMs: 6_000, endMs: 11_000 }),
        draft({ id: "c", label: "HOOK", startMs: 12_000, endMs: 17_000 }),
      ],
      60_000,
    );
    expect(specs.map((s) => s.label)).toEqual(["hook", "hook-2", "hook-3"]);
  });

  it("carries burnCaptions through and rounds ms", () => {
    const specs = draftsToSpecs(
      [draft({ id: "a", label: "x", startMs: 1_000.4, endMs: 6_000.6, burnCaptions: true })],
      30_000,
    );
    expect(specs[0]).toEqual({ label: "x", startMs: 1_000, endMs: 6_001, burnCaptions: true });
  });

  it("returns [] when nothing is valid", () => {
    expect(draftsToSpecs([draft({ startMs: 5_000, endMs: 5_000 })], 30_000)).toEqual([]);
  });
});
