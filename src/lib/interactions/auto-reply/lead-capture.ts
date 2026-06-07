// Bet 4 — comment→DM lead capture (X / Bluesky / LinkedIn).
//
// =======================================================================
// PURE RULE LOGIC + DEFENSIVE post_outcomes WRITER.
// =======================================================================
// The flow this module powers (orchestrated in dm-send.ts, run from the
// poll-interactions cron):
//   1. An inbound comment/mention matches a workspace keyword rule
//      (e.g. "pricing", "demo", "how much"), parsed from
//      social_accounts.lead_keyword_rule (migration 046).
//   2. We send a DIRECT MESSAGE to the author containing a configured link
//      (lead magnet / booking page), guarded by a per-channel runtime
//      capability check (see src/lib/social/*: xSendDm / blueskySendDm /
//      linkedinSendDm). If the account lacks DM capability, the send is a
//      clean, audited no-op.
//   3. On a successful send, the interaction is tagged as a captured lead
//      in `post_outcomes` (outcome_type='lead') via tagLeadOutcome. That
//      table EXISTS on this branch (migration 042) but we keep the
//      defensive guard so a future schema drift never breaks the path.
//
// This file stays PURE + side-effect-isolated: the matcher and rule parser
// are exhaustively unit-testable, and the only DB touch (tagLeadOutcome) is
// hard-guarded. The networked orchestration lives in dm-send.ts.
// =======================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/db/types";

type ServiceClient = SupabaseClient<Database>;

export interface LeadKeywordRule {
  // Case-insensitive substrings that, when found in an inbound body, mark
  // it as a lead intent. e.g. ["pricing", "demo", "how much", "trial"].
  keywords: string[];
  // The link we DM back (lead magnet / booking page).
  link: string;
  // Optional cents value to attribute to a captured lead in post_outcomes.
  valueCents?: number;
  // Optional DM body template. `{{link}}` is substituted with `link`. When
  // absent, buildDmBody falls back to a neutral default. Capped to the DM
  // length ceiling at build time.
  message?: string;
}

// Parse + validate a raw social_accounts.lead_keyword_rule JSON blob into a
// LeadKeywordRule, or null when it's absent/malformed/unusable. A usable rule
// needs at least one non-trivial keyword AND a non-empty link — anything less
// means the comment→DM path must no-op (no_rule), never guess. Fail-closed:
// any parse ambiguity returns null rather than a half-built rule.
export function parseLeadKeywordRule(raw: Json | null | undefined): LeadKeywordRule | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  const rawKeywords = obj.keywords;
  if (!Array.isArray(rawKeywords)) return null;
  const keywords = rawKeywords
    .filter((k): k is string => typeof k === "string")
    .map((k) => k.trim())
    .filter((k) => k.length >= 2);
  if (keywords.length === 0) return null;

  const link = typeof obj.link === "string" ? obj.link.trim() : "";
  if (link.length === 0) return null;

  const valueCents =
    typeof obj.valueCents === "number" && Number.isFinite(obj.valueCents) && obj.valueCents >= 0
      ? Math.floor(obj.valueCents)
      : undefined;
  const message =
    typeof obj.message === "string" && obj.message.trim().length > 0
      ? obj.message
      : undefined;

  return { keywords, link, ...(valueCents !== undefined ? { valueCents } : {}), ...(message ? { message } : {}) };
}

// DM body ceiling — matches the manual composer + the dm_capture_log CHECK.
export const DM_BODY_MAX = 3000;

// Build the DM body from the rule. Substitutes `{{link}}` in the template (or
// appends the link to a neutral default), then clamps to DM_BODY_MAX. Always
// returns a non-empty string when the rule has a link.
export function buildDmBody(rule: LeadKeywordRule): string {
  const template =
    rule.message && rule.message.includes("{{link}}")
      ? rule.message
      : rule.message
        ? `${rule.message}\n\n${rule.link}`
        : `Thanks for reaching out! Here's the link you asked about: {{link}}`;
  const body = template.replace(/\{\{link\}\}/g, rule.link).trim();
  return body.length > DM_BODY_MAX ? body.slice(0, DM_BODY_MAX) : body;
}

// Pure keyword matcher — the one piece of this flow that's testable today.
// Returns the first matched keyword, or null. Loose substring match,
// mirroring the priority.ts customer-list matcher's deliberate looseness.
export function matchLeadKeyword(
  body: string,
  rule: LeadKeywordRule,
): string | null {
  if (!body || rule.keywords.length === 0) return null;
  const haystack = body.toLowerCase();
  for (const raw of rule.keywords) {
    const needle = raw.trim().toLowerCase();
    if (needle.length >= 2 && haystack.includes(needle)) return needle;
  }
  return null;
}

export interface LeadCaptureInput {
  workspaceId: string;
  // The synthetic post row the reply created (post_outcomes.post_id FK).
  postId: string | null;
  matchedKeyword: string;
  valueCents: number;
  note: string;
}

// Defensive write to `post_outcomes`. The table EXISTS on this branch now
// (migration 042), and the comment→DM orchestrator (dm-send.ts) calls this on
// every successful auto-DM. We KEEP the hard guard regardless: a schema drift,
// an RLS surprise, or a future column rename must NEVER break the DM path —
// a lead-tag miss is logged (lead_tagged=false) but the DM still counts.
// Returns true iff the row was actually written.
export async function tagLeadOutcome(
  svc: ServiceClient,
  input: LeadCaptureInput,
): Promise<boolean> {
  if (!input.postId) return false;
  try {
    // Reached via an untyped escape hatch + hard guard. Even though the table
    // is now in our generated Database types, the defensive path is cheap and
    // keeps this the ONLY place we touch that table, with one failure mode.
    const table = (svc as unknown as {
      from: (t: string) => {
        insert: (row: Record<string, unknown>) => Promise<{ error: { message: string; code?: string } | null }>;
      };
    }).from("post_outcomes");
    const { error } = await table.insert({
      workspace_id: input.workspaceId,
      post_id: input.postId,
      outcome_type: "lead",
      value_cents: input.valueCents,
      note: input.note,
    });
    if (error) {
      console.warn("[lead-capture] post_outcomes write skipped:", error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(
      "[lead-capture] post_outcomes write threw (table likely not deployed yet):",
      err instanceof Error ? err.message : "unknown",
    );
    return false;
  }
}
