import { supabaseService } from "@/lib/supabase/service";
import type { PlanId } from "@/lib/billing/tiers";

// ─────────────────────────────────────────────────────────────
// Entitlement resolution (Phase A scaffold — Phase C billing fills this in)
// ─────────────────────────────────────────────────────────────
//
// Single entry point for "which plan governs this workspace's quotas?".
//
//   * Solo workspace (organization_id null) → the workspace's OWN plan.
//     This is byte-for-byte today's behaviour.
//   * Client workspace (organization_id set) → INHERIT the organization's
//     plan (locked decision #1: the org holds one subscription; client
//     workspaces are free sub-tenants that inherit entitlements).
//
// Phase C (billing) fills this in: the resolver now factors the org's
// `subscription_status`. When an org's subscription is in a non-paying state
// (past_due / unpaid / canceled / incomplete / incomplete_expired) we DOWNGRADE
// inherited client workspaces to 'hobby' rather than letting them keep agency
// ceilings on an unpaid subscription. An org with no subscription yet (status
// null, e.g. just created, before first checkout) is treated as a paying org on
// its `plan` column — same as before — so the create-org → add-client flow keeps
// working while the operator wires up Stripe. (Stripe statuses: active,
// trialing, past_due, canceled, unpaid, incomplete, incomplete_expired, paused.)
//
// IMPORTANT: this is THE function the assertWithin*Quota helpers in
// src/lib/billing/limits.ts already call (getPlanForWorkspace delegates here).
// Org-aware logic lives HERE, not in each assert helper, so the four quota
// checks (posts / images / videos / channels) all inherit the org plan in one
// place.

export interface ResolvedEntitlement {
  // The plan whose TierLimits govern this workspace's quotas.
  plan: PlanId;
  // Where the plan came from: the workspace's own plan (solo) or the
  // org's plan (inherited). Lets callers explain "limit set by your agency".
  source: "workspace" | "organization";
  // The org id when the plan was inherited; null for solo workspaces.
  organizationId: string | null;
}

/**
 * Resolve the effective plan + its source for a workspace.
 *
 * Single DB read of the workspace (plan + organization_id); a second read of
 * the organization only when the workspace is a client of an org. Falls back
 * to 'hobby' if a row is missing (defensive — shouldn't happen for an
 * authenticated workspace).
 */
export async function resolveEntitlement(workspaceId: string): Promise<ResolvedEntitlement> {
  const svc = supabaseService();

  const { data: ws } = await svc
    .from("workspaces")
    .select("plan, organization_id")
    .eq("id", workspaceId)
    .maybeSingle();

  // Solo path (organization_id null) — unchanged from before the org layer.
  if (!ws?.organization_id) {
    return {
      plan: (ws?.plan as PlanId | undefined) ?? "hobby",
      source: "workspace",
      organizationId: null,
    };
  }

  // Client workspace — inherit the org's plan.
  const { data: org } = await svc
    .from("organizations")
    .select("plan, subscription_status")
    .eq("id", ws.organization_id)
    .maybeSingle();

  // If the org row is somehow missing, fall back to the workspace's own plan
  // so quota checks never crash and a client is never accidentally upgraded.
  if (!org) {
    return {
      plan: (ws.plan as PlanId | undefined) ?? "hobby",
      source: "workspace",
      organizationId: ws.organization_id,
    };
  }

  // A non-paying subscription downgrades the whole org's clients to hobby. We
  // only honour the inherited paid plan when the org either has no subscription
  // yet (status null — pre-checkout) or is in a paying/grace state.
  const inheritedPlan = (org.plan as PlanId | undefined) ?? "agency";
  const effectivePlan = orgPlanIsActive(org.subscription_status) ? inheritedPlan : "hobby";

  return {
    plan: effectivePlan,
    source: "organization",
    organizationId: ws.organization_id,
  };
}

// Stripe subscription statuses that still entitle the org's clients to its paid
// plan. `null` covers an org that hasn't started a subscription yet (just
// created, or billing not configured on the deployment) — we don't punish it.
// Everything else (past_due, unpaid, canceled, incomplete, incomplete_expired,
// paused) drops inherited clients to hobby until billing is healthy again.
const ACTIVE_ORG_STATUSES = new Set(["active", "trialing"]);

function orgPlanIsActive(status: string | null | undefined): boolean {
  if (status == null) return true;
  return ACTIVE_ORG_STATUSES.has(status);
}

/**
 * Convenience: just the effective PlanId. Used by the quota assert helpers in
 * src/lib/billing/limits.ts (via getPlanForWorkspace).
 */
export async function resolvePlanForWorkspace(workspaceId: string): Promise<PlanId> {
  return (await resolveEntitlement(workspaceId)).plan;
}
