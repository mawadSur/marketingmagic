// Handle-finder — candidate schema (zod re-validation of the model's tool call).
//
// The generator forces a single tool call that returns N brandable handle
// candidates. We re-validate here (the tool's JSON-schema bounds are belt; this
// is suspenders) and normalise each handle to the common base form before it's
// ever probed.

import { z } from "zod";
import { normalizeHandle } from "./platforms";

export const MIN_CANDIDATES = 4;
export const MAX_CANDIDATES = 12;
export const DEFAULT_CANDIDATES = 8;

// One AI-proposed handle. `handle` is the bare username (no @, no domain);
// `rationale` is a short why-this-works note shown under the candidate.
export const handleCandidateSchema = z.object({
  handle: z
    .string()
    .min(1)
    .max(30)
    // Defensive: coerce to the common base form. Per-platform validity is
    // checked later (some platforms are stricter than this).
    .transform((h) => normalizeHandle(h))
    .refine((h) => h.length >= 2, "Handle too short after normalisation."),
  rationale: z.string().min(1).max(200),
});

export const handleCandidatesSchema = z.object({
  candidates: z.array(handleCandidateSchema).min(1).max(MAX_CANDIDATES),
});

export type HandleCandidate = z.infer<typeof handleCandidateSchema>;
export type HandleCandidates = z.infer<typeof handleCandidatesSchema>;

// The brand context fed to the generator. All optional — the feature works off
// a bare seed word too (a brand-new user before they've written a brief).
export interface HandleSeed {
  // A word/phrase the user wants the handle built around (brand name, niche).
  seed?: string;
  productDescription?: string;
  voice?: string;
  targetAudience?: string;
}

// De-dup + drop empties after normalisation, preserving model order. Two
// candidates that normalise to the same base handle collapse to one.
export function dedupeCandidates(candidates: HandleCandidate[]): HandleCandidate[] {
  const seen = new Set<string>();
  const out: HandleCandidate[] = [];
  for (const c of candidates) {
    if (!c.handle || seen.has(c.handle)) continue;
    seen.add(c.handle);
    out.push(c);
  }
  return out;
}
