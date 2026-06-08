import { z } from "zod";

// ─────────────────────────────────────────────────────────────
// Interaction schemas (Phase 4.5 — Reply Inbox + Engagement Assistant)
// ─────────────────────────────────────────────────────────────
//
// Mirror of the `public.interactions` row plus a few derived enums
// the UI uses to bucket priorities into coarse bands. Two narrow
// schemas live here:
//
//   1. interactionChannelSchema / interactionStatusSchema — direct
//      mirrors of the CHECK constraints in migration 023. Used by the
//      pollers when validating remote responses before insert.
//
//   2. interactionRowSchema — full row shape, used when we re-load a
//      row in a server action and want to assert it's well-formed
//      before passing it into the draft-reply flow.
//
// Keep this file dependency-free (Zod only). It must be safe to import
// from both server and "use client" components.

// Mirrors migration 023 CHECK (channel in ...). Same set as
// CompetitorWatchChannel but defined here so the inbox module doesn't
// reach into competitors.
export const interactionChannelSchema = z.enum([
  "x",
  "linkedin",
  "bluesky",
  "instagram",
  "threads",
]);
export type InteractionChannel = z.infer<typeof interactionChannelSchema>;

// Mirrors migration 023 CHECK (status in ...).
export const interactionStatusSchema = z.enum([
  "unread",
  "read",
  "replied",
  "snoozed",
  "dismissed",
  // TODO #0 (migration 056): auto-ignored as spam by the poll-interactions
  // spam pass. Distinct from 'dismissed' (a manual human clear) so the inbox
  // can surface an explicit "auto-ignored as spam" review lane.
  "ignored",
]);
export type InteractionStatus = z.infer<typeof interactionStatusSchema>;

// ─────────────────────────────────────────────────────────────
// InteractionPriority — coarse band the UI filters by.
// ─────────────────────────────────────────────────────────────
//
// We bucket the 0-100 priority_score into three bands so the filter
// chips on /inbox stay tractable. Thresholds intentionally generous on
// the low end so the cold-start ("no signal yet") case lands in `low`
// rather than spamming the high lane.
//
//   high   → priority_score >= 70
//   medium → 35 <= priority_score < 70
//   low    → priority_score < 35 (or null)
//
// Anything beyond this granularity belongs as columns, not bands.
export const interactionPrioritySchema = z.enum(["high", "medium", "low"]);
export type InteractionPriority = z.infer<typeof interactionPrioritySchema>;

export const PRIORITY_HIGH_MIN = 70;
export const PRIORITY_MEDIUM_MIN = 35;

export function bandForScore(score: number | null | undefined): InteractionPriority {
  if (score == null) return "low";
  if (score >= PRIORITY_HIGH_MIN) return "high";
  if (score >= PRIORITY_MEDIUM_MIN) return "medium";
  return "low";
}

// ─────────────────────────────────────────────────────────────
// Full interaction row schema.
// ─────────────────────────────────────────────────────────────
//
// Used when re-loading an interaction inside a server action. We're
// permissive on the timestamp fields (string only — we don't try to
// coerce into Date here; that's done at the rendering boundary).
export const interactionRowSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  social_account_id: z.string().uuid(),
  channel: interactionChannelSchema,
  external_id: z.string().min(1).max(200),
  parent_post_id: z.string().uuid().nullable(),
  author_handle: z.string().min(1).max(200),
  author_display_name: z.string().nullable(),
  body: z.string().min(1).max(8000),
  received_at: z.string(),
  status: interactionStatusSchema,
  priority_score: z.number().nullable(),
  // TODO #0 (migration 056): 0-100 spam likelihood (higher = spammier). NULL
  // until the poll-time spam classifier runs. Optional on read for back-compat
  // with rows persisted before the column existed.
  spam_score: z.number().nullable().optional(),
  snooze_until: z.string().nullable(),
  replied_at: z.string().nullable(),
  replied_to_post_id: z.string().uuid().nullable(),
  created_at: z.string(),
});
export type InteractionRow = z.infer<typeof interactionRowSchema>;

// Age-filter chip used by the /inbox UI. "all" returns the whole set
// (capped at the server-side LIMIT); the others trim received_at.
export const interactionAgeFilterSchema = z.enum(["24h", "7d", "all"]);
export type InteractionAgeFilter = z.infer<typeof interactionAgeFilterSchema>;

// Snooze duration. We hard-code 24h here because shortcut keys are the
// primary UX; longer snoozes can be done by re-snoozing the next day.
// Centralised so the cron sweeper + the UI both reference one constant.
export const SNOOZE_DURATION_MS = 24 * 60 * 60 * 1000;
