// PLG loop, first slice — free-tier attribution.
//
// On HOBBY-plan workspaces ONLY, optionally append a subtle
// "Made with marketingmagic" line to published posts. Two gates, both must
// pass:
//   1. plan === 'hobby'        — resolved via resolvePlanForWorkspace, so an
//      org-inherited PAID plan (or a paid solo plan) is correctly excluded.
//   2. attribution_enabled      — the workspace toggle (migration 030), default
//      TRUE for hobby out of the box, hideable/off from /settings/referrals.
//
// applyAttribution is called at BOTH publish sites (the queue publish-now
// action and the post-scheduled cron) right before dispatchPost, so the line
// ships on every channel without touching the channel-specific dispatch logic.

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolvePlanForWorkspace } from "@/lib/billing/entitlements";

// The line itself. Leading blank line separates it from the post body. Kept
// short + lowercase-brand so it reads as a humble footer, not an ad.
export const ATTRIBUTION_LINE = "Made with marketingmagic";

/**
 * Decide whether the attribution line should be appended for this workspace.
 * True iff the effective plan is hobby AND the workspace toggle is on.
 * Defensive: a missing workspace row or any read failure resolves to FALSE
 * (never append when unsure).
 */
export async function shouldAppendAttribution(
  svc: SupabaseClient,
  workspaceId: string,
): Promise<boolean> {
  const plan = await resolvePlanForWorkspace(workspaceId);
  if (plan !== "hobby") return false;

  const { data } = await svc
    .from("workspaces")
    .select("attribution_enabled")
    .eq("id", workspaceId)
    .maybeSingle();
  return data?.attribution_enabled === true;
}

/**
 * Return `text` with the attribution line appended when the workspace qualifies,
 * otherwise the original text unchanged. Idempotent: if the text already ends
 * with the line (e.g. a retry re-runs the publish path) we don't append twice.
 */
export async function applyAttribution(
  svc: SupabaseClient,
  workspaceId: string,
  text: string,
): Promise<string> {
  if (!(await shouldAppendAttribution(svc, workspaceId))) return text;
  return appendAttributionLine(text);
}

/**
 * Pure text transform (no DB): append the attribution line unless it's already
 * present at the end. Exposed for unit tests + reuse.
 */
export function appendAttributionLine(text: string): string {
  const trimmed = text.replace(/\s+$/, "");
  if (trimmed.endsWith(ATTRIBUTION_LINE)) return trimmed;
  return `${trimmed}\n\n${ATTRIBUTION_LINE}`;
}
