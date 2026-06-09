import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Unit: account-level entitlement lift (gap coverage for multi-workspace sharing) ──
//
// tests/unit/billing-entitlements.test.ts validates the core account-level
// sharing path (a paid sibling lifts a hobby workspace). This file adds the GAP
// cases that weren't covered: complex multi-workspace scenarios, edge cases
// around subscription status transitions, and plan-rank precedence.

type WsRow = {
  plan: string | null;
  organization_id: string | null;
  subscription_status: string | null;
  owner_id?: string | null;
};
type OrgRow = { plan: string | null; subscription_status: string | null } | null;
type SiblingRow = { id: string; plan: string | null; subscription_status: string | null };

const wsRow: { value: WsRow } = {
  value: { plan: "hobby", organization_id: null, subscription_status: null, owner_id: "owner-1" },
};
const orgRow: { value: OrgRow } = { value: null };
const siblingRows: { value: SiblingRow[] } = { value: [] };

vi.mock("@/lib/supabase/service", () => ({
  supabaseService: () => ({
    from(table: string) {
      if (table !== "workspaces") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: orgRow.value, error: null }) }),
          }),
        };
      }
      return {
        select: (cols: string) => {
          const isSiblingRead = cols.trim().startsWith("id");
          if (isSiblingRead) {
            const result = Promise.resolve({ data: siblingRows.value, error: null });
            const builder: Record<string, unknown> = {
              eq: () => builder,
              is: () => builder,
              neq: () => builder,
              then: (r: (v: unknown) => unknown) => result.then(r),
            };
            return builder;
          }
          return {
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: wsRow.value, error: null }) }),
          };
        },
      };
    },
  }),
}));

import { resolveEntitlement } from "@/lib/billing/entitlements";

function setSolo(plan: string | null, subscription_status: string | null) {
  wsRow.value = { plan, organization_id: null, subscription_status, owner_id: "owner-1" };
  orgRow.value = null;
  siblingRows.value = [];
}

beforeEach(() => {
  setSolo("hobby", null);
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("resolveEntitlement: account-level lift — gap coverage", () => {
  it("lifts to 'agency' when the sibling is on the highest-tier plan", async () => {
    // agency outranks founder and pro in planRank().
    setSolo("hobby", null);
    siblingRows.value = [{ id: "ws-A", plan: "agency", subscription_status: "active" }];
    const e = await resolveEntitlement("ws");
    expect(e.plan).toBe("agency");
    expect(e.source).toBe("account");
  });

  it("picks 'founder' over 'pro' when both are active (higher planRank)", async () => {
    // founder outranks pro (Creator > Solo).
    setSolo("hobby", null);
    siblingRows.value = [
      { id: "ws-A", plan: "pro", subscription_status: "active" },
      { id: "ws-B", plan: "founder", subscription_status: "active" },
    ];
    const e = await resolveEntitlement("ws");
    expect(e.plan).toBe("founder");
    expect(e.source).toBe("account");
  });

  it("ignores a 'paused' sibling (non-paying status)", async () => {
    setSolo("hobby", null);
    siblingRows.value = [{ id: "ws-A", plan: "pro", subscription_status: "paused" }];
    const e = await resolveEntitlement("ws");
    expect(e.plan).toBe("hobby");
    expect(e.source).toBe("workspace");
  });

  it("ignores an 'incomplete' sibling (checkout not finished)", async () => {
    setSolo("hobby", null);
    siblingRows.value = [{ id: "ws-A", plan: "founder", subscription_status: "incomplete" }];
    const e = await resolveEntitlement("ws");
    expect(e.plan).toBe("hobby");
    expect(e.source).toBe("workspace");
  });

  it("LIFTS using a 'past_due' sibling (Stripe grace window is still paying)", async () => {
    setSolo("hobby", null);
    siblingRows.value = [{ id: "ws-A", plan: "pro", subscription_status: "past_due" }];
    const e = await resolveEntitlement("ws");
    expect(e.plan).toBe("pro");
    expect(e.source).toBe("account");
  });

  it("LIFTS using a 'trialing' sibling (pre-payment trial)", async () => {
    setSolo("hobby", null);
    siblingRows.value = [{ id: "ws-A", plan: "founder", subscription_status: "trialing" }];
    const e = await resolveEntitlement("ws");
    expect(e.plan).toBe("founder");
    expect(e.source).toBe("account");
  });

  it("ignores an 'incomplete_expired' sibling", async () => {
    setSolo("hobby", null);
    siblingRows.value = [{ id: "ws-A", plan: "pro", subscription_status: "incomplete_expired" }];
    const e = await resolveEntitlement("ws");
    expect(e.plan).toBe("hobby");
    expect(e.source).toBe("workspace");
  });

  it("picks the BEST plan when multiple paying siblings exist (agency > founder > pro)", async () => {
    setSolo("hobby", null);
    siblingRows.value = [
      { id: "ws-A", plan: "pro", subscription_status: "active" },
      { id: "ws-B", plan: "agency", subscription_status: "active" },
      { id: "ws-C", plan: "founder", subscription_status: "active" },
    ];
    const e = await resolveEntitlement("ws");
    expect(e.plan).toBe("agency");
    expect(e.source).toBe("account");
  });

  it("ignores a sibling with a lapsed subscription even when the plan is high-tier", async () => {
    // agency plan, but status is 'canceled' → non-paying, can't lift.
    setSolo("hobby", null);
    siblingRows.value = [{ id: "ws-A", plan: "agency", subscription_status: "canceled" }];
    const e = await resolveEntitlement("ws");
    expect(e.plan).toBe("hobby");
    expect(e.source).toBe("workspace");
  });

  it("lifts when this workspace is non-paying AND a sibling is paying (lapsed → inherited)", async () => {
    // This workspace had a paid plan but the sub lapsed; it now inherits from a paying sibling.
    setSolo("pro", "unpaid");
    siblingRows.value = [{ id: "ws-A", plan: "founder", subscription_status: "active" }];
    const e = await resolveEntitlement("ws");
    expect(e.plan).toBe("founder");
    expect(e.source).toBe("account");
  });

  it("does NOT lift when this workspace is paying (even if a sibling has a better plan)", async () => {
    // This workspace pays for itself (pro, active) — no need to check siblings.
    setSolo("pro", "active");
    siblingRows.value = [{ id: "ws-A", plan: "agency", subscription_status: "active" }];
    const e = await resolveEntitlement("ws");
    expect(e.plan).toBe("pro");
    expect(e.source).toBe("workspace");
  });

  it("stays hobby when all siblings are hobby (no paid plan to inherit)", async () => {
    setSolo("hobby", null);
    siblingRows.value = [
      { id: "ws-A", plan: "hobby", subscription_status: null },
      { id: "ws-B", plan: "hobby", subscription_status: null },
    ];
    const e = await resolveEntitlement("ws");
    expect(e.plan).toBe("hobby");
    expect(e.source).toBe("workspace");
  });

  it("lifts when one sibling is paying and others are lapsed", async () => {
    // Three siblings: two lapsed, one active. The active one lifts this workspace.
    setSolo("hobby", null);
    siblingRows.value = [
      { id: "ws-A", plan: "pro", subscription_status: "canceled" },
      { id: "ws-B", plan: "founder", subscription_status: "active" },
      { id: "ws-C", plan: "agency", subscription_status: "unpaid" },
    ];
    const e = await resolveEntitlement("ws");
    expect(e.plan).toBe("founder");
    expect(e.source).toBe("account");
  });

  it("lifts to the highest ACTIVE plan when multiple active siblings exist (ignores lapsed high-tier)", async () => {
    // agency is lapsed (canceled), founder and pro are active → founder wins.
    setSolo("hobby", null);
    siblingRows.value = [
      { id: "ws-A", plan: "agency", subscription_status: "canceled" },
      { id: "ws-B", plan: "founder", subscription_status: "active" },
      { id: "ws-C", plan: "pro", subscription_status: "active" },
    ];
    const e = await resolveEntitlement("ws");
    expect(e.plan).toBe("founder");
    expect(e.source).toBe("account");
  });

  it("does NOT downgrade a workspace that has its own paid plan (account sharing only LIFTS)", async () => {
    // This workspace is on 'founder' (active). A sibling is on 'pro' (active).
    // Account sharing never lowers entitlement, so this stays 'founder'.
    setSolo("founder", "active");
    siblingRows.value = [{ id: "ws-A", plan: "pro", subscription_status: "active" }];
    const e = await resolveEntitlement("ws");
    expect(e.plan).toBe("founder");
    expect(e.source).toBe("workspace");
  });
});
