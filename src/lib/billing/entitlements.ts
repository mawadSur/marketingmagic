import { supabaseService } from "@/lib/supabase/service";
import type { PlanId } from "@/lib/billing/tiers";

// ─────────────────────────────────────────────────────────────
// Entitlement resolution (Phase A scaffold — Phase C billing fills this in)
// ─────────────────────────────────────────────────────────────
//
// Single entry point for "which plan governs this workspace's quotas?".
//
//   * Solo workspace (organization_id null) → the workspace's OWN plan,
//     gated by its own `subscription_status` (see below).
//   * Client workspace (organization_id set) → INHERIT the organization's
//     plan (locked decision #1: the org holds one subscription; client
//     workspaces are free sub-tenants that inherit entitlements).
//
// Both paths factor `subscription_status` through the SAME helper
// (subscriptionPlanIsActive / ACTIVE_SUBSCRIPTION_STATUSES). When a subscriber's
// subscription is in a non-paying state (unpaid / paused / canceled / incomplete
// / incomplete_expired) we DOWNGRADE to 'hobby' rather than letting it keep paid
// ceilings on a subscription that isn't paying. `past_due` is treated as STILL
// entitled — that's Stripe's grace/dunning retry window (see the comment on the
// status set). A subscriber with no subscription yet (status null, e.g. just
// created, before first checkout) is treated as paying on its `plan` column —
// same as before — so the onboarding flow keeps working while the operator
// wires up Stripe. (Stripe statuses: active, trialing, past_due, canceled,
// unpaid, incomplete, incomplete_expired, paused.)
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
    .select("plan, organization_id, subscription_status")
    .eq("id", workspaceId)
    .maybeSingle();

  // Solo path (organization_id null) — the workspace's OWN plan, but gated by
  // its Stripe subscription_status so a non-paying solo customer falls back to
  // hobby. This mirrors the org policy below (subscriptionPlanIsActive): we honour
  // the paid plan while the subscription is actually paying (or in grace, or
  // pre-checkout with a null status). A solo customer whose card fails would
  // otherwise keep full paid limits through weeks of Stripe dunning
  // (past_due → unpaid) — the revenue leak this gate closes.
  if (!ws?.organization_id) {
    const ownPlan = (ws?.plan as PlanId | undefined) ?? "hobby";
    const effectivePlan = subscriptionPlanIsActive(ws?.subscription_status) ? ownPlan : "hobby";
    return {
      plan: effectivePlan,
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
  const effectivePlan = subscriptionPlanIsActive(org.subscription_status) ? inheritedPlan : "hobby";

  return {
    plan: effectivePlan,
    source: "organization",
    organizationId: ws.organization_id,
  };
}

// Stripe subscription statuses that still entitle a subscriber (solo workspace
// OR an org and its inherited clients) to its paid plan. Shared by both the
// solo and org branches above so the paying-state policy lives in ONE place.
//
//   * `active` / `trialing` — paying (or in a paid trial): entitled.
//   * `past_due` — KEEP ENTITLED. This is Stripe's grace/dunning window: the
//     latest invoice failed but Stripe is still auto-retrying the card. We don't
//     punish a customer mid-retry — yanking their limits while a retry might
//     still succeed is a bad experience. Stripe escalates to `unpaid` (or
//     `canceled`, per the subscription's dunning settings) once retries are
//     exhausted; that's where we hard-gate. To make the grace window stricter
//     later, just remove "past_due" from this set.
//   * everything else (`unpaid`, `paused`, `incomplete`, `incomplete_expired`,
//     `canceled`) drops the subscriber to hobby until billing is healthy again.
//
// `null` covers a subscriber that hasn't started a subscription yet (just
// created, or billing not configured on the deployment) — we don't punish it.
const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "past_due"]);

function subscriptionPlanIsActive(status: string | null | undefined): boolean {
  if (status == null) return true;
  return ACTIVE_SUBSCRIPTION_STATUSES.has(status);
}

/**
 * Convenience: just the effective PlanId. Used by the quota assert helpers in
 * src/lib/billing/limits.ts (via getPlanForWorkspace).
 */
export async function resolvePlanForWorkspace(workspaceId: string): Promise<PlanId> {
  return (await resolveEntitlement(workspaceId)).plan;
}
