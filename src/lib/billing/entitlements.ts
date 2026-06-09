import { supabaseService } from "@/lib/supabase/service";
import type { PlanId } from "@/lib/billing/tiers";

// ─────────────────────────────────────────────────────────────
// Entitlement resolution (Phase A scaffold — Phase C billing fills this in)
// ─────────────────────────────────────────────────────────────
//
// Single entry point for "which plan governs this workspace's quotas?".
//
//   * Client workspace (organization_id set) → INHERIT the organization's
//     plan (locked decision #1: the org holds one subscription; client
//     workspaces are free sub-tenants that inherit entitlements).
//   * Solo workspace (organization_id null) → the workspace's OWN plan,
//     gated by its own `subscription_status` (see below) — AND, when the
//     workspace itself isn't on a paying plan, it INHERITS the best active
//     paid plan among the OTHER workspaces owned by the same user (account-
//     level entitlement sharing — see resolveAccountPlan). This is what makes
//     "one subscription covers all MY workspaces" true for solo/Creator users,
//     not only agencies: a second workspace I create is no longer paywalled at
//     Free just because billing lives on my first workspace. It is scoped to a
//     SINGLE owner_id — it never shares entitlements across different users.
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
  // Where the plan came from:
  //   "workspace"    — the workspace's own paid (or hobby) plan.
  //   "organization" — inherited from the agency org this workspace belongs to.
  //   "account"      — inherited from another workspace owned by the same user
  //                    (account-level sharing: my paid plan covers my other
  //                    solo workspaces). Lets callers explain "covered by your
  //                    <plan> subscription on another workspace".
  source: "workspace" | "organization" | "account";
  // The org id when the plan was inherited from an org; null otherwise.
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
    .select("plan, organization_id, subscription_status, owner_id")
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

    // Account-level sharing: if THIS workspace isn't itself on a paying plan,
    // inherit the best active paid plan among the OTHER workspaces this same
    // user owns. That's what makes "my subscription covers all my workspaces"
    // true — a second workspace I create starts on hobby (its own plan) but is
    // lifted to my paid plan instead of being paywalled at Free. We only LIFT
    // (never downgrade): a workspace already entitled to a paid plan keeps it.
    if (effectivePlan === "hobby" && ws?.owner_id) {
      const accountPlan = await resolveAccountPlan(svc, ws.owner_id, workspaceId);
      if (accountPlan && accountPlan !== "hobby") {
        return { plan: accountPlan, source: "account", organizationId: null };
      }
    }

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

// Account-level plan: the BEST active paid plan among the solo workspaces a
// single user owns, EXCLUDING the workspace we're resolving for (it already
// failed its own paying check, and we don't want a self-referential read). Used
// only to LIFT a non-paying workspace to the owner's paid entitlement. Returns
// null when the user has no other paying solo workspace.
//
// Scoping rules (deliberate, to avoid leaking entitlements the wrong way):
//   * owner_id match only — never crosses to a different user.
//   * organization_id IS NULL — org/client workspaces bill through the org
//     path, not here; their plan column isn't the source of truth.
//   * each candidate is gated by its OWN subscription_status (same paying-state
//     policy as the solo branch) so a lapsed sub on workspace A can't prop up
//     workspace B.
async function resolveAccountPlan(
  svc: ReturnType<typeof supabaseService>,
  ownerId: string,
  excludeWorkspaceId: string,
): Promise<PlanId | null> {
  const { data: siblings } = await svc
    .from("workspaces")
    .select("id, plan, subscription_status")
    .eq("owner_id", ownerId)
    .is("organization_id", null)
    .neq("id", excludeWorkspaceId);

  if (!siblings?.length) return null;

  let best: PlanId | null = null;
  for (const row of siblings) {
    const plan = (row.plan as PlanId | undefined) ?? "hobby";
    if (plan === "hobby") continue;
    // Only an actively-paying sibling can lift another workspace.
    if (!subscriptionPlanIsActive(row.subscription_status)) continue;
    if (best === null || planRank(plan) > planRank(best)) best = plan;
  }
  return best;
}

// Orders plans by entitlement ceiling so resolveAccountPlan can pick the BEST
// one a user owns. Higher = more entitlement. agency outranks founder (Creator)
// because it carries the highest limits in tiers.ts; founder outranks pro (Solo)
// because Creator adds the voice-memo capability on top of Solo's ceilings.
function planRank(plan: PlanId): number {
  switch (plan) {
    case "agency":
      return 3;
    case "founder":
      return 2;
    case "pro":
      return 1;
    default:
      return 0; // hobby
  }
}

// ─────────────────────────────────────────────────────────────
// Workspace-creation gate (paywall): how many workspaces can this account have?
// ─────────────────────────────────────────────────────────────
//
// Policy: the Free (hobby) plan includes exactly ONE workspace. A user gets
// their first workspace free (onboarding); creating ADDITIONAL workspaces
// requires a paid entitlement. This pairs with account-level sharing
// (resolveEntitlement) — one paid subscription both COVERS all your workspaces
// AND is what lets you create more than one in the first place. Org owners /
// members are always allowed (the agency tier is explicitly multi-workspace).
//
// "Paid" here means an actively-paying owned workspace OR org membership — the
// same active-status policy as everywhere else (subscriptionPlanIsActive).
export interface WorkspaceCreationGate {
  // True → the create form is allowed. False → show the paywall.
  allowed: boolean;
  // Why it's allowed/blocked, so the UI + action can branch + explain.
  reason: "first_workspace" | "paid_plan" | "organization" | "free_plan_limit";
  // How many workspaces the user already owns (solo + org-owned).
  ownedCount: number;
}

// Resolve whether `ownerId` may create ANOTHER workspace. Service-role read so
// it sees plan/subscription columns regardless of the caller's session, and so
// the count isn't narrowed by RLS. Exported + testable in isolation.
export async function resolveWorkspaceCreationGate(
  ownerId: string,
  svc: ReturnType<typeof supabaseService> = supabaseService(),
): Promise<WorkspaceCreationGate> {
  // All workspaces this user OWNS (solo + any they own under an org). We gate on
  // ownership, not membership: an agency staffer added to someone else's org
  // creates clients through the org flow, not this one.
  const { data: owned } = await svc
    .from("workspaces")
    .select("plan, subscription_status, organization_id")
    .eq("owner_id", ownerId);

  const ownedCount = owned?.length ?? 0;

  // First workspace is always free — this is the onboarding path for a brand-new
  // user (zero workspaces). Never paywall someone out of having any workspace.
  if (ownedCount === 0) {
    return { allowed: true, reason: "first_workspace", ownedCount };
  }

  // Owning (or belonging to) an organization means the agency tier, which is
  // explicitly multi-workspace — always allowed to add more.
  const { count: orgCount } = await svc
    .from("organizations")
    .select("id", { count: "exact", head: true })
    .eq("owner_id", ownerId);
  if ((orgCount ?? 0) > 0) {
    return { allowed: true, reason: "organization", ownedCount };
  }

  // Otherwise: allowed only if the account has at least one actively-paying
  // solo workspace. A free (or lapsed) account is capped at its existing
  // workspace(s) and must upgrade to add another.
  const hasPaid = (owned ?? []).some((w) => {
    const plan = (w.plan as PlanId | undefined) ?? "hobby";
    return plan !== "hobby" && subscriptionPlanIsActive(w.subscription_status);
  });

  return hasPaid
    ? { allowed: true, reason: "paid_plan", ownedCount }
    : { allowed: false, reason: "free_plan_limit", ownedCount };
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
