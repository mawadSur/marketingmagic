"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";
import { syncOrgSubscriptionQuantity } from "@/lib/billing/org-subscription";

// ─────────────────────────────────────────────────────────────
// Org billing — re-sync Stripe seat quantity (Phase C drift control)
// ─────────────────────────────────────────────────────────────
//
// The org billing page surfaces "drift": when the number of active client
// workspaces (seats) disagrees with the quantity Stripe is actually billing.
// Drift happens when a Stripe quantity update failed best-effort during
// add/remove-client (syncOrgSubscriptionQuantitySafe swallows the throw) and no
// webhook/page-visit has reconciled it yet. This action lets an org admin force
// the reconciliation on demand.
//
// AUTHORIZATION (org-admin-only, no privilege escalation): the caller must be
// the org OWNER or hold an 'admin' org_membership role — the same gate that
// guards add-client (which also moves the seat count). We prove this via the
// user_is_org_admin(org_id) RPC (SECURITY DEFINER, owner-or-'admin'), evaluated
// under the caller's auth session. A 'manager' member or a non-member is
// rejected. The org id comes only from the form and the RPC re-derives the
// caller's role from auth.uid(), so a forged/manager request can't escalate.
// Unlike syncOrgSubscriptionQuantitySafe (the best-effort side-effect path),
// here we DO surface a Stripe failure to the operator — this is an explicit,
// operator-initiated reconciliation, not a side-effect.

export type ResyncState = { error: string | null; ok: boolean };

const schema = z.object({ organization_id: z.string().uuid() });

export async function resyncOrgQuantityAction(
  _prev: ResyncState,
  formData: FormData,
): Promise<ResyncState> {
  const parsed = schema.safeParse({ organization_id: formData.get("organization_id") });
  if (!parsed.success) return { error: "Bad request.", ok: false };

  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You must be signed in.", ok: false };

  // Org-admin gate (owner or 'admin'). The RPC re-derives the role from
  // auth.uid() — a manager or non-member fails closed.
  const { data: isAdmin, error: authzErr } = await supabase.rpc("user_is_org_admin", {
    org_id: parsed.data.organization_id,
  });
  if (authzErr || isAdmin !== true) {
    return { error: "Only an organization admin can re-sync billing.", ok: false };
  }

  try {
    await syncOrgSubscriptionQuantity(parsed.data.organization_id);
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Failed to re-sync with Stripe.",
      ok: false,
    };
  }

  revalidatePath("/settings/organization/billing");
  return { error: null, ok: true };
}
