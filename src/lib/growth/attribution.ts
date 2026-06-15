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
import { siteUrl } from "@/lib/env";

// The brand prefix. Kept short + lowercase-brand so it reads as a humble
// footer, not an ad.
export const ATTRIBUTION_PREFIX = "Made with marketingmagic";

// Attribution ref param so we can measure how many leads the PLG loop mints.
// Plain `?ref=post` reads cleanly in the bare-URL rendering and is enough to
// segment attribution traffic in analytics.
const ATTRIBUTION_REF = "ref=post";

/**
 * The full attribution line, including a clickable site URL with the ref param,
 * e.g. `Made with marketingmagic — https://app.example.com/?ref=post`.
 *
 * Computed lazily (not a module const) because siteUrl() reads runtime env —
 * deferring keeps it correct across dev/preview/prod without depending on env
 * being present at import time. Posts render as PLAIN TEXT on social platforms,
 * so the bare URL (no markdown/html) is intentional and reads well as text.
 */
export function attributionLine(): string {
  return `${ATTRIBUTION_PREFIX} — ${siteUrl()}/?${ATTRIBUTION_REF}`;
}

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
 *
 * Idempotency is keyed on the stable brand prefix (not the full URL line) so a
 * retry never double-appends even if siteUrl() were to resolve differently
 * between the original publish and the retry.
 */
export function appendAttributionLine(text: string): string {
  const trimmed = text.replace(/\s+$/, "");
  const lastLine = trimmed.slice(trimmed.lastIndexOf("\n") + 1);
  if (lastLine.startsWith(ATTRIBUTION_PREFIX)) return trimmed;
  return `${trimmed}\n\n${attributionLine()}`;
}
