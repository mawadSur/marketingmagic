import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Unit: entitlement resolution (src/lib/billing/entitlements.ts) ───────────
//
// resolveEntitlement reads a workspace (plan, organization_id, subscription_status)
// and — for client workspaces — the org it belongs to. We mock supabaseService so
// we can dial those rows precisely. The focus here is the solo-downgrade gate:
// a solo workspace on a paid plan whose subscription is non-paying must fall back
// to hobby, mirroring the org policy. `past_due` is the documented grace exception.

// Mutable rows returned by the fake DB. `wsRow` is the workspaces row, `orgRow`
// is the organizations row (only read for client workspaces).
type WsRow = { plan: string | null; organization_id: string | null; subscription_status: string | null };
type OrgRow = { plan: string | null; subscription_status: string | null } | null;

const wsRow: { value: WsRow } = {
  value: { plan: "pro", organization_id: null, subscription_status: "active" },
};
const orgRow: { value: OrgRow } = { value: null };

vi.mock("@/lib/supabase/service", () => ({
  supabaseService: () => ({
    from(table: string) {
      const row = table === "workspaces" ? wsRow.value : orgRow.value;
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: row, error: null }),
          }),
        }),
      };
    },
  }),
}));

import { resolveEntitlement, resolvePlanForWorkspace } from "@/lib/billing/entitlements";

function setSolo(plan: string | null, subscription_status: string | null) {
  wsRow.value = { plan, organization_id: null, subscription_status };
  orgRow.value = null;
}

beforeEach(() => {
  setSolo("pro", "active");
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("resolveEntitlement: solo workspace — paying / pre-checkout states keep the paid plan", () => {
  it("keeps the paid plan when status is 'active'", async () => {
    setSolo("pro", "active");
    const e = await resolveEntitlement("ws");
    expect(e.plan).toBe("pro");
    expect(e.source).toBe("workspace");
    expect(e.organizationId).toBeNull();
  });

  it("keeps the paid plan when status is 'trialing'", async () => {
    setSolo("pro", "trialing");
    expect((await resolveEntitlement("ws")).plan).toBe("pro");
  });

  it("keeps the paid plan when status is null (no subscription yet / pre-checkout)", async () => {
    setSolo("pro", null);
    expect((await resolveEntitlement("ws")).plan).toBe("pro");
  });

  it("keeps the paid plan when status is 'past_due' (Stripe grace/dunning window)", async () => {
    // DECISION: past_due is the retry window — don't punish a customer mid-retry.
    setSolo("founder", "past_due");
    expect((await resolveEntitlement("ws")).plan).toBe("founder");
  });
});

describe("resolveEntitlement: solo workspace — non-paying states fall back to hobby", () => {
  it("downgrades to hobby when status is 'unpaid' (dunning exhausted)", async () => {
    setSolo("pro", "unpaid");
    expect((await resolveEntitlement("ws")).plan).toBe("hobby");
  });

  it("downgrades to hobby when status is 'paused'", async () => {
    setSolo("pro", "paused");
    expect((await resolveEntitlement("ws")).plan).toBe("hobby");
  });

  it("downgrades to hobby when status is 'incomplete_expired'", async () => {
    setSolo("agency", "incomplete_expired");
    expect((await resolveEntitlement("ws")).plan).toBe("hobby");
  });

  it("downgrades to hobby when status is 'canceled'", async () => {
    setSolo("pro", "canceled");
    expect((await resolveEntitlement("ws")).plan).toBe("hobby");
  });

  it("downgrades to hobby when status is 'incomplete'", async () => {
    setSolo("pro", "incomplete");
    expect((await resolveEntitlement("ws")).plan).toBe("hobby");
  });

  it("a hobby workspace stays hobby regardless of status (no-op downgrade)", async () => {
    setSolo("hobby", "unpaid");
    expect((await resolveEntitlement("ws")).plan).toBe("hobby");
  });

  it("resolvePlanForWorkspace surfaces the gated plan (unpaid → hobby)", async () => {
    setSolo("pro", "unpaid");
    expect(await resolvePlanForWorkspace("ws")).toBe("hobby");
  });
});
