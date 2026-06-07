import { z } from "zod";
import { planVariantSchema } from "@/lib/plan/schema";

// ─────────────────────────────────────────────────────────────
// Atomization schema (Bet 2 — Atomization Engine)
// ─────────────────────────────────────────────────────────────
//
// One long-form source → N "atoms". An atom is a single distinct point /
// angle / takeaway lifted from the source. Each atom fans out into per-channel
// variants — EXACTLY the same variant shape the planner uses (channel cap +
// skip + rationale + optional image_prompt + voice_score), so we reuse
// `planVariantSchema` verbatim rather than redefining per-channel validation.
//
// The difference from a plan: there is no multi-week calendar, no
// suggested_scheduled_at, and no posts/ideas dual shape. Atomization is a
// direct 1→N decomposition of a single piece of content; scheduling is left to
// the queue (drafts land unscheduled in pending_approval). Theme tags carry
// through so atomized drafts flow into the same learning loop as plan posts.

export const atomSchema = z.object({
  // Short human-readable label for the atom — used for logging/debugging and
  // surfaced as the idea_label on the draft so the queue can group an atom's
  // channel variants together (mirrors the planner's idea grouping).
  atom_label: z.string().min(1).max(120),
  // Free-form theme tag (reuse the source's own theme tags where they fit).
  // Same concept as planIdeaSchema.theme so atomized drafts measure per-theme
  // in the existing analytics rollups.
  theme: z.string().min(1).max(60),
  // The variants reuse the planner's variant schema 1:1 (per-channel cap is
  // re-validated there).
  variants: z.array(planVariantSchema).min(1).max(8),
});

export const atomizationSchema = z.object({
  // A short overview of how the source was decomposed — surfaced to the user
  // and stored on the parent plan row's generation_prompt.
  overview: z.string().min(1).max(800),
  atoms: z.array(atomSchema).min(1).max(40),
});

export type Atom = z.infer<typeof atomSchema>;
export type Atomization = z.infer<typeof atomizationSchema>;
