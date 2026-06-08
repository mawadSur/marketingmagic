import { z } from "zod";

// VoiceProfile zod schema — mirrors the VoiceProfile interface in
// src/lib/db/types.ts exactly. Used at two boundaries:
//   1. Validating Claude's tool-use output in src/lib/voice/extract.ts.
//   2. Validating the persisted column when read back (defensive — jsonb
//      could in principle drift).
//
// Keep this in lockstep with the Database["brand_briefs"]["Row"]["voice_profile"]
// type and the prompt instructions in extract.ts.
export const voiceProfileSchema = z.object({
  vocabulary_signature: z.string().min(1).max(1000),
  opener_patterns: z.array(z.string().min(1).max(200)).max(20).default([]),
  // Average words per sentence. Reference posts that are extremely short
  // (single-word) or extremely long (multi-paragraph essays) can produce
  // outliers; clamp to a reasonable range rather than fail validation.
  sentence_length_avg: z.number().min(1).max(80),
  formality: z.enum(["casual", "neutral", "formal"]),
  emoji_usage: z.enum(["none", "sparse", "frequent"]),
  punctuation_quirks: z.array(z.string().min(1).max(200)).max(20).default([]),
  do_not_say: z.array(z.string().min(1).max(120)).max(30).default([]),
  signature_phrases: z.array(z.string().min(1).max(200)).max(20).default([]),
  summary: z.string().min(1).max(800),
  extracted_at: z.string().datetime(),
  source_count: z.number().int().min(1).max(100),
});

export type VoiceProfileParsed = z.infer<typeof voiceProfileSchema>;

// Diff proposed by the weekly evolution cron. Stored as
// brand_briefs.pending_voice_diff; user accepts/dismisses in UI.
export const voiceProfileDiffSchema = z.object({
  rationale: z.string().min(1).max(1000),
  add_do_not_say: z.array(z.string().min(1).max(120)).max(20).optional(),
  remove_do_not_say: z.array(z.string().min(1).max(120)).max(20).optional(),
  formality: z.enum(["casual", "neutral", "formal"]).optional(),
  emoji_usage: z.enum(["none", "sparse", "frequent"]).optional(),
  add_signature_phrases: z.array(z.string().min(1).max(200)).max(20).optional(),
  remove_signature_phrases: z.array(z.string().min(1).max(200)).max(20).optional(),
  summary_patch: z.string().min(1).max(800).optional(),
  source_rejection_count: z.number().int().min(0),
  // TODO #0 (gap 2): how many of the user's OWN sent/published exemplars
  // informed this diff. The evolution cron now folds genuine-voice samples
  // (published posts + manually-sent replies) in alongside rejections, so a
  // diff can converge TOWARD how the user writes, not just away from what they
  // rejected. 0 / omitted = a rejection-only diff (legacy behaviour).
  source_sent_count: z.number().int().min(0).optional(),
  proposed_at: z.string().datetime(),
});

export type VoiceProfileDiffParsed = z.infer<typeof voiceProfileDiffSchema>;
