import { describe, expect, it } from "vitest";

import {
  segmentsToSrt,
  segmentsToVtt,
  sliceSegments,
} from "@/lib/video/uploads/captions";
import type { TranscriptSegment } from "@/lib/video/uploads/types";

// ── Unit: caption helpers (src/lib/video/uploads/captions.ts) ────────────────
//
// Pure formatting + slicing. Locks the two timestamp formats (SRT comma vs VTT
// dot, HH:MM:SS rollover) and the clip-window slicing edge cases (overlap,
// clamping, re-basing to zero, empties).

const seg = (startMs: number, endMs: number, text: string): TranscriptSegment => ({
  startMs,
  endMs,
  text,
});

describe("segmentsToSrt", () => {
  it("renders 1-indexed blocks with comma-separated millis", () => {
    const out = segmentsToSrt([seg(0, 1500, "Hello"), seg(1500, 3200, "world")]);
    expect(out).toBe(
      "1\n00:00:00,000 --> 00:00:01,500\nHello\n\n" +
        "2\n00:00:01,500 --> 00:00:03,200\nworld\n",
    );
  });

  it("formats hours/minutes/seconds rollover correctly", () => {
    // 3_661_001 ms = 1h 01m 01s 001ms
    const out = segmentsToSrt([seg(3_661_001, 3_662_000, "tick")]);
    expect(out).toContain("01:01:01,001 --> 01:01:02,000");
  });

  it("returns empty string for no segments", () => {
    expect(segmentsToSrt([])).toBe("");
  });

  it("collapses newlines inside a cue body", () => {
    const out = segmentsToSrt([seg(0, 1000, "line one\nline two")]);
    expect(out).toContain("line one line two");
    // No stray newline that would split the block.
    expect(out).not.toContain("line one\nline two");
  });

  it("floors negative timestamps to zero", () => {
    const out = segmentsToSrt([seg(-500, 1000, "x")]);
    expect(out).toContain("00:00:00,000 --> 00:00:01,000");
  });
});

describe("segmentsToVtt", () => {
  it("always starts with the WEBVTT header", () => {
    expect(segmentsToVtt([]).startsWith("WEBVTT")).toBe(true);
  });

  it("renders cues with dot-separated millis (no cue index)", () => {
    const out = segmentsToVtt([seg(0, 1500, "Hello"), seg(1500, 3200, "world")]);
    expect(out).toBe(
      "WEBVTT\n\n" +
        "00:00:00.000 --> 00:00:01.500\nHello\n\n" +
        "00:00:01.500 --> 00:00:03.200\nworld\n",
    );
  });

  it("returns a valid empty VTT for no segments", () => {
    expect(segmentsToVtt([])).toBe("WEBVTT\n\n");
  });

  it("uses a dot, never a comma, before millis", () => {
    const out = segmentsToVtt([seg(61_500, 62_000, "x")]);
    expect(out).toContain("00:01:01.500 --> 00:01:02.000");
    expect(out).not.toContain(",500");
  });
});

describe("sliceSegments", () => {
  const base = [
    seg(0, 1000, "a"),
    seg(1000, 2000, "b"),
    seg(2000, 3000, "c"),
    seg(3000, 4000, "d"),
  ];

  it("re-bases overlapping segments to a zero-based clip window", () => {
    const out = sliceSegments(base, 1000, 3000);
    expect(out).toEqual([
      { startMs: 0, endMs: 1000, text: "b" },
      { startMs: 1000, endMs: 2000, text: "c" },
    ]);
  });

  it("clamps a segment that straddles the window boundary", () => {
    // Window [1500, 2500) clips both "b" (1000-2000) and "c" (2000-3000).
    const out = sliceSegments(base, 1500, 2500);
    expect(out).toEqual([
      { startMs: 0, endMs: 500, text: "b" },
      { startMs: 500, endMs: 1000, text: "c" },
    ]);
  });

  it("excludes a segment that only touches the window edge", () => {
    // "a" ends exactly at winStart=1000 → no real overlap → dropped.
    const out = sliceSegments(base, 1000, 2000);
    expect(out).toEqual([{ startMs: 0, endMs: 1000, text: "b" }]);
  });

  it("returns empty for an inverted or zero-length window", () => {
    expect(sliceSegments(base, 2000, 2000)).toEqual([]);
    expect(sliceSegments(base, 3000, 1000)).toEqual([]);
  });

  it("returns empty for no segments", () => {
    expect(sliceSegments([], 0, 1000)).toEqual([]);
  });

  it("keeps a fully-contained segment unchanged except for the offset", () => {
    const out = sliceSegments([seg(5000, 6000, "mid")], 4000, 8000);
    expect(out).toEqual([{ startMs: 1000, endMs: 2000, text: "mid" }]);
  });

  it("produces slice captions that round-trip through segmentsToSrt", () => {
    const sliced = sliceSegments(base, 1000, 3000);
    const srt = segmentsToSrt(sliced);
    expect(srt).toContain("00:00:00,000 --> 00:00:01,000\nb");
    expect(srt).toContain("00:00:01,000 --> 00:00:02,000\nc");
  });
});
