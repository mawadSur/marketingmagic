// Pure range-math helpers for the clip editor (slice E).
//
// Kept out of the "use client" component so the in/out range arithmetic +
// label slugging are cheap to unit-test (tests/unit/uploads-editor.test.ts).
// No React, no I/O, no env. Timestamps are MILLISECONDS, matching ClipSpec.

import type { ClipSpec } from "@/lib/video/uploads/types";

// A draft clip being edited in the UI. Carries a stable client id so React can
// key rows and the user can edit/remove a specific draft; `label` is the raw
// user-typed text (slugged to a ClipSpec.label only at submit time).
export interface DraftClip {
  id: string;
  label: string;
  startMs: number;
  endMs: number;
  burnCaptions: boolean;
}

// Smallest clip we'll let the user create. A sub-second clip is almost always a
// mis-drag and produces a useless render, so we reject it at the boundary.
export const MIN_CLIP_MS = 500;

// Clamp a millisecond value into [0, max]. NaN → 0; negative → 0; +Infinity or
// over-max → max (treat "past the end" as the end).
export function clampMs(ms: number, max: number): number {
  if (Number.isNaN(ms)) return 0;
  if (ms < 0) return 0;
  if (ms > max) return max;
  return Math.round(ms);
}

// Duration of a draft in ms (never negative).
export function clipDurationMs(clip: { startMs: number; endMs: number }): number {
  return Math.max(0, clip.endMs - clip.startMs);
}

// Is this single draft a valid, cuttable range within a source of `durationMs`?
// Requires start < end, at least MIN_CLIP_MS long, and both ends inside the
// source. `durationMs <= 0` (unknown source length) only checks ordering+min so
// the user isn't blocked before metadata loads.
export function isValidRange(
  clip: { startMs: number; endMs: number },
  durationMs: number,
): boolean {
  if (!Number.isFinite(clip.startMs) || !Number.isFinite(clip.endMs)) return false;
  if (clip.startMs < 0 || clip.endMs <= clip.startMs) return false;
  if (clip.endMs - clip.startMs < MIN_CLIP_MS) return false;
  if (durationMs > 0 && clip.endMs > durationMs + 1) return false;
  return true;
}

// Slugify a user-typed label into a filesystem-safe, MPT-friendly slug used for
// the clip's output filename (`<task_id>/<label>.mp4`) and the clip_label
// column. Lowercase, ASCII alnum + single dashes, trimmed, capped. Empty /
// all-punctuation input falls back to `clip-<n>` so every clip still gets a
// unique, valid name.
export function slugifyLabel(raw: string, index: number): string {
  const base = (raw ?? "")
    .toLowerCase()
    .normalize("NFKD")
    // Drop the combining diacritical marks NFKD splits off (é → e + ◌́) so
    // "café" slugs to "cafe", not "cafe-".
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return base.length > 0 ? base : `clip-${index + 1}`;
}

// Format a millisecond offset as `M:SS` (or `H:MM:SS` past an hour) for compact
// timeline labels. Negative/NaN → "0:00".
export function formatClock(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}

// Convert the editable drafts into the ClipSpec[] the server action sends to
// slice-D startClipJobs. Drops invalid ranges, de-dupes output labels (a
// duplicate slug would overwrite another clip's `<label>.mp4`), and slugs each
// label deterministically by its surviving index.
export function draftsToSpecs(drafts: DraftClip[], durationMs: number): ClipSpec[] {
  const valid = drafts.filter((d) => isValidRange(d, durationMs));
  const seen = new Set<string>();
  const out: ClipSpec[] = [];
  valid.forEach((d, i) => {
    let label = slugifyLabel(d.label, i);
    // Ensure uniqueness so two clips never collide on the same output filename.
    if (seen.has(label)) {
      let n = 2;
      while (seen.has(`${label}-${n}`)) n += 1;
      label = `${label}-${n}`;
    }
    seen.add(label);
    out.push({
      label,
      startMs: Math.round(d.startMs),
      endMs: Math.round(d.endMs),
      burnCaptions: Boolean(d.burnCaptions),
    });
  });
  return out;
}
