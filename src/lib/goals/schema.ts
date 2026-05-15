import { z } from "zod";

// ─────────────────────────────────────────────────────────────
// Content-goal schemas (Phase 2.1 — Reverse-Plan from a Goal)
// ─────────────────────────────────────────────────────────────
//
// Three adjacent shapes live here:
//
//   1. GoalDraft — what /goals/new collects from the structured
//      questionnaire. Wide on purpose (numeric target, ISO date, free-form
//      text) so the form action can normalize before persisting.
//
//   2. GoalStrategy — what reverse-plan.ts gets back from Claude. This is
//      the JSONB shape persisted to `content_goals.strategy` and re-read
//      verbatim by the strategy-preview page and generate-plan.ts. The
//      reverse-planner is told to emit:
//        - theme_weights      — how to bias the planner's theme mix
//        - posting_cadence    — per-channel posts/week
//        - milestone_narrative — week-by-week arc the plan should follow
//        - weeks              — 4–12; the planner consumes this directly
//        - success_criteria   — bullet list of "we hit it when ___" signals
//
//   3. ProposeStrategyResult — Claude can return either a strategy OR a
//      "this goal isn't realistic; closest achievable is X" envelope. This
//      is the goal-realism gate — we never silently inflate. The
//      strategy-preview page renders the warning when `realistic: false`.
//
// All three are re-validated by zod after the tool-use call so the JSON
// Schema in reverse-plan.ts doesn't have to be bulletproof on its own.

// Matches the CHECK constraint on content_goals.goal_metric (migration 018).
export const goalMetricSchema = z.enum([
  "followers",
  "inbound",
  "launch_date",
  "credibility",
  "recovery",
  "custom",
]);
export type GoalMetric = z.infer<typeof goalMetricSchema>;

// Matches the CHECK constraint on content_goals.status (migration 018).
export const goalStatusSchema = z.enum([
  "draft",
  "active",
  "paused",
  "achieved",
  "abandoned",
]);
export type GoalStatus = z.infer<typeof goalStatusSchema>;

// Form input for /goals/new. The server action narrows this then hands
// the structured object off to proposeStrategy().
//
// We don't enforce target_value+target_date as a refinement here — for
// credibility / launch_date goals the value is qualitative. The realism
// gate handles "this goal doesn't have enough signal to plan against."
export const goalDraftSchema = z.object({
  goal_metric: goalMetricSchema,
  goal_text: z
    .string()
    .trim()
    .min(10, "Describe the goal in at least 10 characters.")
    .max(1000, "Trim the goal description to 1000 characters."),
  target_value: z.number().finite().positive().optional(),
  target_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date (YYYY-MM-DD).")
    .optional(),
});
export type GoalDraft = z.infer<typeof goalDraftSchema>;

// Per-theme weight Claude returns. `theme` is a free-form short tag matching
// the existing planner theme convention (lowercase, hyphen-separated);
// `weight` is a 0–1 share — values should approximately sum to 1 across
// all themes but we don't enforce it (Claude is calibrated enough; the
// planner uses these as a soft bias, not hard quotas).
export const themeWeightSchema = z.object({
  theme: z.string().trim().min(1).max(60),
  weight: z.number().min(0).max(1),
  rationale: z.string().trim().min(1).max(400),
});
export type ThemeWeight = z.infer<typeof themeWeightSchema>;

// Per-channel cadence target. Matches the shape generate-plan.ts will
// feed into the standard planner's `channelMix`. Channels not listed are
// implicitly 0 — the strategy may legitimately skip a channel ("LinkedIn
// is wrong for this audience"); the rationale should explain why.
export const channelCadenceSchema = z.object({
  channel: z.enum(["x", "linkedin", "threads", "instagram", "bluesky"]),
  posts_per_week: z.number().int().min(0).max(28),
  rationale: z.string().trim().min(1).max(400),
});
export type ChannelCadence = z.infer<typeof channelCadenceSchema>;

// Week-by-week arc. The planner reads this verbatim into the system
// prompt so generated posts feel like they belong to a coherent story
// rather than a random pile.
export const milestoneSchema = z.object({
  week: z.number().int().min(1).max(12),
  focus: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(600),
});
export type Milestone = z.infer<typeof milestoneSchema>;

// The full structured strategy. Persisted verbatim to
// `content_goals.strategy` as JSONB and re-read by the preview page.
export const goalStrategySchema = z.object({
  // Planner consumes this directly as the `weeks` field of PlanGenInputs.
  weeks: z.number().int().min(1).max(12),
  // Short prose summary of the strategy — surfaced at the top of the
  // preview page. 2–4 sentences.
  summary: z.string().trim().min(1).max(1200),
  theme_weights: z.array(themeWeightSchema).min(1).max(10),
  posting_cadence: z.array(channelCadenceSchema).min(1).max(8),
  milestones: z.array(milestoneSchema).min(1).max(12),
  success_criteria: z.array(z.string().trim().min(1).max(280)).min(1).max(8),
  // Free-form risks / caveats Claude wants to surface even when the goal
  // is realistic. Optional — empty array means "no caveats."
  risks: z.array(z.string().trim().min(1).max(280)).max(6).default([]),
});
export type GoalStrategy = z.infer<typeof goalStrategySchema>;

// Goal-realism gate envelope. Claude returns one of:
//   { realistic: true, strategy: GoalStrategy }
//   { realistic: false, reason: "...", closest_achievable: GoalStrategy }
//
// We treat the "closest_achievable" path as a STRONG signal — the UI
// shows it as a warning banner with both targets surfaced ("you asked for
// 5k followers in 4 weeks; the closest plan we can defend is 1.5k").
export const proposeStrategyResultSchema = z.discriminatedUnion("realistic", [
  z.object({
    realistic: z.literal(true),
    strategy: goalStrategySchema,
  }),
  z.object({
    realistic: z.literal(false),
    reason: z.string().trim().min(1).max(800),
    // Closest plan Claude thinks IS defensible. Same shape, so the user
    // can one-click approve it without going back to the questionnaire.
    closest_achievable: goalStrategySchema,
  }),
]);
export type ProposeStrategyResult = z.infer<typeof proposeStrategyResultSchema>;
