import { z } from "zod";
import type { PostOutcomeType } from "@/lib/db/types";

// Outcome Loop MVP (Bet 1) — domain schema for self-reported post outcomes.
//
// One surface: recordOutcomeAction reads a form with the post id, an outcome
// type, an optional dollar amount, and an optional note. We validate at the
// boundary here so the server action stays thin and every caller mints the
// same shape. SCOPE: self-report only (no UTM / pixel — deferred phase 2).

// Source of truth for the outcome-type vocabulary. Mirrors the CHECK on
// post_outcomes.outcome_type (migration 042) and PostOutcomeType in db/types.ts.
// The "Mark outcome" picker renders straight off this list.
export const OUTCOME_TYPES = [
  "lead",
  "sale",
  "signup",
  "booking",
  "other",
] as const satisfies ReadonlyArray<PostOutcomeType>;

export const outcomeTypeSchema = z.enum(OUTCOME_TYPES);

// Human labels + a one-line helper for the picker. Kept next to the schema so
// the UI and validation never drift.
export const OUTCOME_TYPE_LABELS: Record<PostOutcomeType, string> = {
  lead: "Lead",
  sale: "Sale",
  signup: "Signup",
  booking: "Booking",
  other: "Other",
};

// Dollars are entered by humans ("$49.99"); we store CENTS as an exact integer.
// $1,000,000 is a generous ceiling that still fits well inside int4.
const MAX_DOLLARS = 1_000_000;
const MAX_NOTE = 280;

// Input schema. `amount_dollars` is the RAW form value (a string or empty);
// we coerce → validate → expose `value_cents` so the action never does money
// math inline. An empty amount is legal (value-less outcomes like a lead).
export const recordOutcomeInputSchema = z
  .object({
    post_id: z.string().uuid("Pick a valid post."),
    outcome_type: outcomeTypeSchema,
    // Optional dollar amount. Accept "", undefined, or a positive number-ish
    // string. We DON'T use z.coerce.number() directly because "" coerces to 0,
    // which we want to read as "no amount", not "$0.00".
    amount_dollars: z
      .union([z.string(), z.number()])
      .optional()
      .transform((v) => (v === undefined || v === "" ? null : v))
      .refine(
        (v) => v === null || (Number.isFinite(Number(v)) && Number(v) >= 0),
        "Amount must be a non-negative number.",
      )
      .refine(
        (v) => v === null || Number(v) <= MAX_DOLLARS,
        `Amount must be ${MAX_DOLLARS.toLocaleString()} or less.`,
      ),
    note: z
      .string()
      .trim()
      .max(MAX_NOTE, `Note must be ${MAX_NOTE} characters or fewer.`)
      .optional()
      .transform((v) => (v && v.length > 0 ? v : null)),
  })
  .transform((data) => ({
    post_id: data.post_id,
    outcome_type: data.outcome_type,
    // Exact integer cents (round to the nearest cent to absorb float input).
    value_cents:
      data.amount_dollars === null ? null : Math.round(Number(data.amount_dollars) * 100),
    note: data.note,
  }));

export type RecordOutcomeInput = z.infer<typeof recordOutcomeInputSchema>;
