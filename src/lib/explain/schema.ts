import { z } from "zod";

// The shape Claude must return — enforced via tool_use forcing in
// src/lib/explain/extract.ts. We intentionally constrain `kind` to a closed
// vocabulary so the UI can group reasons consistently and the playbook
// table has a stable `pattern_kind` axis.
export const explainerReasonKindSchema = z.enum([
  "theme",
  "timing",
  "voice",
  "opener",
  "length",
  "other",
]);

export const explainerReasonSchema = z.object({
  kind: explainerReasonKindSchema,
  // Plain-English bullet. Must be hedged ("possibly", "may have") — the
  // Claude system prompt instructs this; we trust the prompt rather than
  // regexing for hedge words.
  detail: z.string().min(8).max(280),
});

export const explainerCardSchema = z.object({
  verdict: z.enum(["winner", "underperformer"]),
  // 3-5 reasons. Each maps to a specific data point we passed in.
  reasons: z.array(explainerReasonSchema).min(3).max(5),
  // One-line summary suitable for "Save to playbook." Plain English, no
  // hedging needed here — when the user saves it they're explicitly
  // endorsing it as a pattern.
  pattern_summary: z.string().min(10).max(160),
});

export type ExplainerReasonKind = z.infer<typeof explainerReasonKindSchema>;
export type ExplainerReason = z.infer<typeof explainerReasonSchema>;
export type ExplainerCard = z.infer<typeof explainerCardSchema>;
