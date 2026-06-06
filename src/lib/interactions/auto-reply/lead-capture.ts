// Bet 4 — comment→DM lead capture.
//
// =======================================================================
// STUBBED — NOT WIRED INTO THE CRON YET.
// =======================================================================
// The intended flow (X / Bluesky / LinkedIn only):
//   1. An inbound comment/mention matches a workspace keyword rule
//      (e.g. "pricing", "demo", "how much").
//   2. We send a DIRECT MESSAGE to the author with a link (lead magnet /
//      booking page), and tag the interaction as a captured lead.
//   3. The lead is recorded in the `post_outcomes` table
//      (workspace_id, post_id, outcome_type='lead', value_cents, note),
//      which ANOTHER agent is currently building. We do NOT create that
//      table; we write to it defensively (no-op if it doesn't exist yet).
//
// WHY IT'S STUBBED, NOT BUILT, IN THIS SLICE:
//   * There is NO DM send helper for X / Bluesky / LinkedIn anywhere in
//     src/lib/social/*. Adding real DM dispatch is a separate, sizeable
//     piece of work (new scopes for X DMs, AT-proto convo APIs for
//     Bluesky, the LinkedIn messaging API + its much stricter approval)
//     and each carries its own anti-spam/abuse surface that deserves its
//     own review — exactly the kind of "auto-DM a stranger" action that
//     warrants more care than the auto-REPLY we shipped here.
//   * `post_outcomes` doesn't exist in this branch yet, so the lead-tag
//     write has nowhere to land. The guard below is the contract for when
//     it does.
//
// The auto-REPLY path (items #1 and #2 of the slice) is fully shipped and
// independent of this. This module exists so the keyword-rule + lead-tag
// shape is pinned down and the post_outcomes dependency is handled
// defensively the day DM dispatch lands.
// =======================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";

type ServiceClient = SupabaseClient<Database>;

export interface LeadKeywordRule {
  // Case-insensitive substrings that, when found in an inbound body, mark
  // it as a lead intent. e.g. ["pricing", "demo", "how much", "trial"].
  keywords: string[];
  // The link we DM back (lead magnet / booking page).
  link: string;
  // Optional cents value to attribute to a captured lead in post_outcomes.
  valueCents?: number;
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

// Defensive write to `post_outcomes`. The table is owned by another agent
// and may not exist yet on this branch. We swallow the "relation does not
// exist" / "schema cache" errors so a missing dependency NEVER breaks the
// auto-reply path. Returns true iff the row was actually written.
//
// NOTE: this is currently only reachable from tests / a future DM wiring —
// the cron does not call it yet (no DM dispatch exists). See the file
// header. // TODO(bet4-dm): wire after a DM send helper + post_outcomes land.
export async function tagLeadOutcome(
  svc: ServiceClient,
  input: LeadCaptureInput,
): Promise<boolean> {
  if (!input.postId) return false;
  try {
    // `post_outcomes` is not in our generated Database types yet (the other
    // agent owns it), so we reach it via an untyped escape hatch and guard
    // hard. This is the ONLY place we touch that table.
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
