import { afterEach, describe, expect, it, vi } from "vitest";

// ── Unit: workspace-creation paywall gate (resolveWorkspaceCreationGate) ─────
//
// The Free plan includes ONE workspace. A brand-new user gets their first free;
// creating MORE needs a paid plan (or an org). The gate runs service-role and
// makes two reads:
//   1. workspaces.select(plan, subscription_status, organization_id).eq(owner_id)
//      → a LIST (awaited directly).
//   2. organizations.select(id, {head,count}).eq(owner_id) → a COUNT.
// We fake both so each scenario can be dialed precisely.

type OwnedRow = { plan: string | null; subscription_status: string | null; organization_id: string | null };

const owned: { value: OwnedRow[] } = { value: [] };
const orgCount: { value: number } = { value: 0 };

vi.mock("@/lib/supabase/service", () => ({
  supabaseService: () => ({
    from(table: string) {
      if (table === "organizations") {
        // .select("id", { head, count }).eq(owner) → { count }
        return {
          select: () => ({
            eq: () => Promise.resolve({ count: orgCount.value, error: null }),
          }),
        };
      }
      // workspaces: .select(...).eq(owner_id) → awaited list
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

describe("resolveWorkspaceCreationGate", () => {
  it("allows the FIRST workspace (brand-new user, zero owned)", async () => {
    set([]);
    const g = await resolveWorkspaceCreationGate("owner-1");
    expect(g.allowed).toBe(true);
    expect(g.reason).toBe("first_workspace");
    expect(g.ownedCount).toBe(0);
  });

  it("BLOCKS a second workspace for a free user (one hobby workspace, no sub)", async () => {
    set([{ plan: "hobby", subscription_status: null, organization_id: null }]);
    const g = await resolveWorkspaceCreationGate("owner-1");
    expect(g.allowed).toBe(false);
    expect(g.reason).toBe("free_plan_limit");
    expect(g.ownedCount).toBe(1);
  });

  it("ALLOWS more workspaces when the user has an actively-paying workspace", async () => {
    set([
      { plan: "pro", subscription_status: "active", organization_id: null },
      { plan: "hobby", subscription_status: null, organization_id: null },
    ]);
    const g = await resolveWorkspaceCreationGate("owner-1");
    expect(g.allowed).toBe(true);
    expect(g.reason).toBe("paid_plan");
  });

  it("treats a CANCELED paid workspace as non-paying (still blocked)", async () => {
    set([{ plan: "pro", subscription_status: "canceled", organization_id: null }]);
    const g = await resolveWorkspaceCreationGate("owner-1");
    expect(g.allowed).toBe(false);
    expect(g.reason).toBe("free_plan_limit");
  });

  it("honors past_due as still-paying (Stripe grace window)", async () => {
    set([{ plan: "founder", subscription_status: "past_due", organization_id: null }]);
    const g = await resolveWorkspaceCreationGate("owner-1");
    expect(g.allowed).toBe(true);
    expect(g.reason).toBe("paid_plan");
  });

  it("ALLOWS when the user owns an organization (agency tier is multi-workspace)", async () => {
    // Even with only hobby solo workspaces, owning an org unlocks more.
    set([{ plan: "hobby", subscription_status: null, organization_id: null }], 1);
    const g = await resolveWorkspaceCreationGate("owner-1");
    expect(g.allowed).toBe(true);
    expect(g.reason).toBe("organization");
  });
});
