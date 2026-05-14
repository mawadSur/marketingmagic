import { z } from "zod";
import { CHANNELS } from "@/lib/channels/registry";

// Per-channel character cap, sourced from the registry so adding a channel
// (or tweaking a limit) only touches one place. The generator's tool schema
// hardcodes the upper bound (LinkedIn's 3000) because JSON Schema can't
// express per-enum-value max-length; we re-validate per-channel here.
const MAX_TEXT = Math.max(...Object.values(CHANNELS).map((c) => c.maxChars));

// ─────────────────────────────────────────────────────────────
// Variant — one channel-tuned rendering of an idea.
// ─────────────────────────────────────────────────────────────
//
// `skip` lets Claude explicitly mark a channel as unsuitable for this idea
// (e.g. a 1200-char essay → skip X). When skip=true, `text` may be empty
// (and is ignored downstream); we keep the row in the schema only so the
// model can report *why* it skipped via `rationale`.
export const planVariantSchema = z
  .object({
    channel: z.enum(["x", "linkedin", "threads", "instagram", "bluesky"]),
    text: z.string().max(MAX_TEXT),
    skip: z.boolean().optional().default(false),
    rationale: z.string().min(1).max(1000),
    image_prompt: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.string().min(1).max(500).optional(),
    ),
    // Phase 1 (Voice Wedge): Claude self-scores per-variant voice fidelity.
    // Optional — unset on legacy plans and when no voice_profile is on the brief.
    voice_score: z.number().min(0).max(100).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.skip) return; // skipped variants don't need text
    if (v.text.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["text"],
        message: "text is required when skip is false",
      });
      return;
    }
    const max = CHANNELS[v.channel].maxChars;
    if (v.text.length > max) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        type: "string",
        maximum: max,
        inclusive: true,
        path: ["text"],
        message: `text exceeds ${v.channel} cap of ${max} characters`,
      });
    }
  });

// ─────────────────────────────────────────────────────────────
// Idea — one piece of content, fanned out into N channel variants.
// ─────────────────────────────────────────────────────────────
export const planIdeaSchema = z.object({
  idea_label: z.string().min(1).max(120),
  theme: z.string().min(1).max(60),
  suggested_scheduled_at: z.string().datetime(),
  variants: z.array(planVariantSchema).min(1).max(8),
});

// Plan — list of ideas. Optional `posts` field preserves the legacy single-
// channel shape so older clients / fallback paths still parse. Exactly one
// of `ideas` or `posts` must be present.
export const planSchema = z
  .object({
    plan_name: z.string().min(1).max(120),
    overview: z.string().min(1).max(800),
    ideas: z.array(planIdeaSchema).min(1).max(50).optional(),
    posts: z.array(planVariantLegacyPostSchema()).min(1).max(50).optional(),
  })
  .refine((p) => Boolean(p.ideas) !== Boolean(p.posts), {
    message: "Plan must include exactly one of `ideas` or `posts`.",
    path: ["ideas"],
  });

// Legacy single-channel post shape (one post per row, no idea wrapper).
// Kept so the system stays backward-compatible if the model regresses.
function planVariantLegacyPostSchema() {
  return z.object({
    channel: z.enum(["x", "linkedin", "threads", "instagram", "bluesky"]),
    text: z.string().min(1).max(MAX_TEXT),
    theme: z.string().min(1).max(60),
    suggested_scheduled_at: z.string().datetime(),
    rationale: z.string().min(1).max(1000),
    image_prompt: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.string().min(1).max(500).optional(),
    ),
    voice_score: z.number().min(0).max(100).optional(),
  });
}

// Re-export the legacy post schema for callers that still need the flat
// shape (e.g. event-rule rendering down the line).
export const planPostSchema = planVariantLegacyPostSchema();

export type PlanVariant = z.infer<typeof planVariantSchema>;
export type PlanIdea = z.infer<typeof planIdeaSchema>;
export type PlanPost = z.infer<typeof planPostSchema>;
export type GeneratedPlan = z.infer<typeof planSchema>;
