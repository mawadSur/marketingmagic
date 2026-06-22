// Pure caption helpers for the user-video-upload feature (migration 068).
//
// Three pure functions, all unit-tested (tests/unit/uploads-captions.test.ts):
//   - segmentsToSrt — render SRT (HH:MM:SS,mmm with a COMMA before millis)
//   - segmentsToVtt — render WebVTT (HH:MM:SS.mmm with a DOT before millis)
//   - sliceSegments — re-base segments to a clip's [startMs,endMs) window so a
//     cut clip carries its own zero-based captions for burn-in/preview.
//
// No I/O, no env, no Supabase — kept pure so the formatting + slicing edge
// cases are cheap to lock down with tests. Timestamps are MILLISECONDS.

import type { TranscriptSegment } from "./types";

// Clamp + integer-ise a possibly-bad millisecond value. Negatives floor to 0
// so a malformed segment can't produce a negative timestamp.
function safeMs(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.round(ms);
}

// Zero-pad a number to `width` digits.
function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

// Format a millisecond offset as `HH:MM:SS<sep>mmm`. `sep` is "," for SRT and
// "." for VTT — the ONLY difference between the two timestamp formats.
function formatTimestamp(ms: number, sep: "," | "."): string {
  const total = safeMs(ms);
  const millis = total % 1000;
  const totalSeconds = Math.floor(total / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}${sep}${pad(millis, 3)}`;
}

// Normalise caption text for a single cue: collapse internal newlines to spaces
// (a stray newline inside a cue body breaks SRT/VTT block parsing) and trim.
function cueText(text: string): string {
  return (text ?? "").replace(/\r?\n/g, " ").trim();
}

// Render an array of segments as an SRT subtitle document. Empty input → "".
// SRT blocks are 1-indexed: `N\nHH:MM:SS,mmm --> HH:MM:SS,mmm\ntext\n\n`.
export function segmentsToSrt(segments: TranscriptSegment[]): string {
  if (!segments || segments.length === 0) return "";
  return (
    segments
      .map((seg, i) => {
        const start = formatTimestamp(seg.startMs, ",");
        const end = formatTimestamp(seg.endMs, ",");
        return `${i + 1}\n${start} --> ${end}\n${cueText(seg.text)}`;
      })
      .join("\n\n") + "\n"
  );
}

// Render an array of segments as a WebVTT subtitle document. Always begins with
// the `WEBVTT` magic header. Empty input → just the header (a valid empty VTT).
// VTT cues use a DOT before millis: `HH:MM:SS.mmm --> HH:MM:SS.mmm\ntext`.
export function segmentsToVtt(segments: TranscriptSegment[]): string {
  const header = "WEBVTT\n";
  if (!segments || segments.length === 0) return header + "\n";
  const body = segments
    .map((seg) => {
      const start = formatTimestamp(seg.startMs, ".");
      const end = formatTimestamp(seg.endMs, ".");
      return `${start} --> ${end}\n${cueText(seg.text)}`;
    })
    .join("\n\n");
  return `${header}\n${body}\n`;
}

// Re-base segments to a clip's [startMs, endMs) window so a cut clip carries its
// own zero-based captions. Returns only segments that OVERLAP the window, with
// timestamps shifted so the clip's start is t=0 and clamped to the window
// length. A segment that touches but doesn't overlap (e.g. ends exactly at
// startMs) is dropped — zero-duration captions are useless.
export function sliceSegments(
  segments: TranscriptSegment[],
  startMs: number,
  endMs: number,
): TranscriptSegment[] {
  if (!segments || segments.length === 0) return [];
  const winStart = safeMs(startMs);
  const winEnd = safeMs(endMs);
  if (winEnd <= winStart) return [];
  const length = winEnd - winStart;

  const out: TranscriptSegment[] = [];
  for (const seg of segments) {
    const s = safeMs(seg.startMs);
    const e = safeMs(seg.endMs);
    // Overlap test: segment must start before the window ends AND end after the
    // window starts. Half-open so a segment ending exactly at winStart (or
    // starting exactly at winEnd) is excluded.
    if (s >= winEnd || e <= winStart) continue;
    const clampedStart = Math.max(s, winStart) - winStart;
    const clampedEnd = Math.min(e, winEnd) - winStart;
    if (clampedEnd <= clampedStart) continue;
    out.push({
      startMs: Math.min(clampedStart, length),
      endMs: Math.min(clampedEnd, length),
      text: seg.text,
    });
  }
  return out;
}
