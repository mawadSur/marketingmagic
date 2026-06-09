import { afterEach, describe, expect, it, vi } from "vitest";

// ── Unit: workspace-creation gate - gap coverage (multi-workspace lift scenarios) ──
//
// The existing tests/unit/workspace-creation-gate.test.ts validates the basic gate
// (first workspace, paid plan, org). This file adds the GAP cases: multi-workspace
// account-level entitlement scenarios that interact with the gate. These cover how
// a paying workspace LIFTS the ability to create MORE workspaces, and edge cases
// around lapsed subscriptions.

type OwnedRow = {
  plan: string | null;
  subscription_status: string | null;
  organization_id: string | null;
};

const owned: { value: OwnedRow[] } = { value: [] };
const orgCount: { value: number } = { value: 0 };

vi.mock("@/lib/supabase/service", () => ({
  supabaseService: () => ({
    from(table: string) {
      if (table === "organizations") {
        return {
          select: () => ({
            eq: () => Promise.resolve({ count: orgCount.value, error: null }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => Promise.resolve({ data: owned.value, error: null }),
        }),
      };
    },
  }),
}));

import { resolveWorkspaceCreationGate } from "@/lib/billing/entitlements";

function set(ownedRows: OwnedRow[], orgs = 0) {
  owned.value = ownedRows;
  orgCount.value = orgs;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("resolveWorkspaceCreationGate: multi-workspace scenarios", () => {
  it("ALLOWS creating a 3rd workspace when the user has 2 already (one paid, one free)", async () => {
    // A user with a paid subscription and one free workspace can add ANOTHER.
    set([
      { plan: "pro", subscription_status: "active", organization_id: null },
      { plan: "hobby", subscription_status: null, organization_id: null },
    ]);
    const g = await resolveWorkspaceCreationGate("owner-1");
    expect(g.allowed).toBe(true);
    expect(g.reason).toBe("paid_plan");
    expect(g.ownedCount).toBe(2);
  });

  it("picks the BEST paid plan when multiple paid workspaces exist", async () => {
    // User has both 'pro' and 'founder' workspaces — both are paying, so creation is allowed.
    set([
      { plan: "pro", subscription_status: "active", organization_id: null },
      { plan: "founder", subscription_status: "active", organization_id: null },
    ]);
    const g = await resolveWorkspaceCreationGate("owner-1");
    expect(g.allowed).toBe(true);
    expect(g.reason).toBe("paid_plan");
  });

  it("BLOCKS when a user has ONE paid workspace but the subscription lapsed", async () => {
    // The workspace had a paid plan but the subscription is now 'unpaid' (dunning exhausted).
    set([{ plan: "pro", subscription_status: "unpaid", organization_id: null }]);
    const g = await resolveWorkspaceCreationGate("owner-1");
    expect(g.allowed).toBe(false);
    expect(g.reason).toBe("free_plan_limit");
  });

  it("ALLOWS creation during past_due (Stripe grace window)", async () => {
    // past_due is still considered paying — the user can add workspaces mid-retry.
    set([{ plan: "founder", subscription_status: "past_due", organization_id: null }]);
    const g = await resolveWorkspaceCreationGate("owner-1");
    expect(g.allowed).toBe(true);
    expect(g.reason).toBe("paid_plan");
  });

  it("BLOCKS when a user has 2 hobby workspaces (no paid plan anywhere)", async () => {
    // Both workspaces are free — user shouldn't be able to create a third.
    set([
      { plan: "hobby", subscription_status: null, organization_id: null },
      { plan: "hobby", subscription_status: null, organization_id: null },
    ]);
    const g = await resolveWorkspaceCreationGate("owner-1");
    expect(g.allowed).toBe(false);
    expect(g.reason).toBe("free_plan_limit");
  });

  it("ALLOWS when a user has a client workspace under an org (multi-workspace tier)", async () => {
    // Client workspaces inherit org plan, but the org owner still needs the org gate.
    // This tests the scenario where a user owns solo workspaces + is org owner.
    set(
      [
        { plan: "hobby", subscription_status: null, organization_id: null },
        { plan: "agency", subscription_status: "active", organization_id: "org-1" },
      ],
      1,
    ); // org count = 1
    const g = await resolveWorkspaceCreationGate("owner-1");
    expect(g.allowed).toBe(true);
    expect(g.reason).toBe("organization");
  });

  it("ALLOWS when a user has 'trialing' subscription (pre-payment trial period)", async () => {
    // Stripe trial counts as paying for the gate.
    set([{ plan: "pro", subscription_status: "trialing", organization_id: null }]);
    const g = await resolveWorkspaceCreationGate("owner-1");
    expect(g.allowed).toBe(true);
    expect(g.reason).toBe("paid_plan");
  });

  it("BLOCKS when a user has 'paused' subscription", async () => {
    // 'paused' is non-paying — no new workspaces until reactivated.
    set([{ plan: "pro", subscription_status: "paused", organization_id: null }]);
    const g = await resolveWorkspaceCreationGate("owner-1");
    expect(g.allowed).toBe(false);
    expect(g.reason).toBe("free_plan_limit");
  });

  it("BLOCKS when the only paid workspace has 'incomplete_expired' status", async () => {
    // 'incomplete_expired' = checkout expired — treated as non-paying.
    set([{ plan: "agency", subscription_status: "incomplete_expired", organization_id: null }]);
    const g = await resolveWorkspaceCreationGate("owner-1");
    expect(g.allowed).toBe(false);
    expect(g.reason).toBe("free_plan_limit");
  });

  it("ALLOWS when one workspace is paying and another is lapsed (the paying one still covers creation)", async () => {
    // User has two workspaces: one active, one lapsed. The active one enables new creation.
    set([
      { plan: "pro", subscription_status: "active", organization_id: null },
      { plan: "founder", subscription_status: "canceled", organization_id: null },
    ]);
    const g = await resolveWorkspaceCreationGate("owner-1");
    expect(g.allowed).toBe(true);
    expect(g.reason).toBe("paid_plan");
  });
});
