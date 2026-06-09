import { z } from "zod";

// ─────────────────────────────────────────────────────────────
// Hook×body variation schema (Hormozi organic-first slice #3)
// ─────────────────────────────────────────────────────────────
//
// ONE source post/concept → a MATRIX of variations. The matrix is a cross
// product of distinct HOOKS (the first ~3 seconds: the scroll-stopper) and
// distinct BODIES (the payload that follows the hook). Default 10 hooks × 3
// bodies = 30 variations — "turn your best clip into 30 you can film."
//
// This is intentionally separate from src/lib/atomize (1 source → N distinct
// *points*) and src/lib/experiments (an existing post → a few alt hooks). Here
// the point is FIXED — we keep the same core message and explore the hook/body
// surface so a creator has 30 fresh takes to film, all tracing back to the one
// that worked (lineage = migration 060).
//
// We force Claude to emit hooks and bodies SEPARATELY (not 30 pre-joined
// blobs) so:
//   • the model can't cheat by lightly rewording one script 30 times — it must
//     commit to N genuinely different openers and M genuinely different payloads;
//   • the cross product is assembled deterministically in code, so the count is
//     guaranteed (hooks.length × bodies.length) rather than left to the model;
//   • each variation carries its source hook_index / body_index for debugging
//     and so the queue can group/label the matrix.

// Matrix bounds. Default is 10×3=30. We cap generously — a creator might want a
// smaller (3×2) or larger (12×4) matrix, but never a runaway request.
export const MIN_HOOKS = 2;
export const MAX_HOOKS = 12;
export const MIN_BODIES = 1;
export const MAX_BODIES = 5;
export const DEFAULT_HOOKS = 10;
export const DEFAULT_BODIES = 3;

// A single hook = the scroll-stopping opener. `spoken` is what's said in the
// first ~3s; `visual` is what's ON SCREEN (the pattern interrupt). Hormozi's
// organic mechanic wants BOTH varied, not just the words.
export const hookSchema = z.object({
  spoken: z.string().trim().min(1).max(280),
  visual: z.string().trim().min(1).max(280),
});

// A single body = the payload after the hook: the point, the proof, the turn.
// The CTA is a TEXT OVERLAY (not spoken) per the organic-native rule — a spoken
// "link in bio" reads as an ad; an overlay reads as organic.
export const bodySchema = z.object({
  spoken: z.string().trim().min(1).max(1200),
  cta_overlay: z.string().trim().min(1).max(120),
});

export const variationMatrixSchema = z.object({
  // Short note on how the source was reframed across hooks/bodies — surfaced to
  // the user and stored on the batch's generation_prompt.
  overview: z.string().trim().min(1).max(800),
  hooks: z.array(hookSchema).min(MIN_HOOKS).max(MAX_HOOKS),
  bodies: z.array(bodySchema).min(MIN_BODIES).max(MAX_BODIES),
});

export type Hook = z.infer<typeof hookSchema>;
export type Body = z.infer<typeof bodySchema>;
export type VariationMatrix = z.infer<typeof variationMatrixSchema>;

// One assembled variation = one hook crossed with one body, plus the joined
// full_text a creator can read off-camera. The indices trace it back into the
// matrix for grouping/labelling.
export interface Variation {
  hook: Hook;
  body: Body;
  hook_index: number;
  body_index: number;
  // The full filmable script: visual hook cue → spoken hook → spoken body →
  // CTA overlay cue. This is the thing that lands in a draft's `text`.
  full_text: string;
}

// Assemble the cross product deterministically. The model commits to the
// distinct hooks/bodies; CODE owns the count so 10×3 is always exactly 30.
export function assembleVariations(matrix: VariationMatrix): Variation[] {
  const out: Variation[] = [];
  matrix.hooks.forEach((hook, hi) => {
    matrix.bodies.forEach((body, bi) => {
      out.push({
        hook,
        body,
        hook_index: hi,
        body_index: bi,
        full_text: composeFullText(hook, body),
      });
    });
  });
  return out;
}

// Compose a single filmable script. Format mirrors how a creator reads a shot
// list: an on-screen-text cue, the spoken hook, the spoken body, then the CTA
// overlay cue (NOT a spoken CTA — organic-native rule).
export function composeFullText(hook: Hook, body: Body): string {
  return [
    `[ON-SCREEN: ${hook.visual}]`,
    hook.spoken,
    "",
    body.spoken,
    "",
    `[CTA OVERLAY: ${body.cta_overlay}]`,
  ].join("\n");
}
