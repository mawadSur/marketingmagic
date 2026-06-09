import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Unit: entitlement resolution (src/lib/billing/entitlements.ts) ───────────
//
// resolveEntitlement reads a workspace (plan, organization_id, subscription_status)
// and — for client workspaces — the org it belongs to. We mock supabaseService so
// we can dial those rows precisely. The focus here is the solo-downgrade gate:
// a solo workspace on a paid plan whose subscription is non-paying must fall back
// to hobby, mirroring the org policy. `past_due` is the documented grace exception.

// Mutable rows returned by the fake DB. `wsRow` is the workspaces row (the one
// being resolved), `orgRow` is the organizations row (only read for client
// workspaces), and `siblingRows` is the set of OTHER solo workspaces owned by
// the same user (read only on the account-level fallback path).
type WsRow = {
  plan: string | null;
  organization_id: string | null;
  subscription_status: string | null;
  owner_id?: string | null;
};
type OrgRow = { plan: string | null; subscription_status: string | null } | null;
type SiblingRow = { id: string; plan: string | null; subscription_status: string | null };

const wsRow: { value: WsRow } = {
  value: { plan: "pro", organization_id: null, subscription_status: "active", owner_id: "owner-1" },
};
const orgRow: { value: OrgRow } = { value: null };
const siblingRows: { value: SiblingRow[] } = { value: [] };

// Fake the supabase service. The single-row reads (workspace + org) resolve via
// .maybeSingle(); the account-level sibling query is a LIST read that ends in
// .neq() (no maybeSingle) and is awaited directly — so the workspaces builder is
// thenable and returns siblingRows. We disambiguate the two workspaces reads by
// the column list: the single-workspace read selects owner_id; the sibling read
// selects id.
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
          // The sibling (account) read is the only one that selects id FIRST.
          const isSiblingRead = cols.trim().startsWith("id");
          if (isSiblingRead) {
            // .eq(owner).is(org,null).neq(id) → awaited list result.
            const result = Promise.resolve({ data: siblingRows.value, error: null });
            const builder: Record<string, unknown> = {
              eq: () => builder,
              is: () => builder,
              neq: () => builder,
              then: (r: (v: unknown) => unknown) => result.then(r),
            };
            return builder;
          }
          // Single-workspace read (selects owner_id) → maybeSingle.
          return {
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: wsRow.value, error: null }) }),
          };
        },
      };
    },
  }),
}));

import { resolveEntitlement, resolvePlanForWorkspace } from "@/lib/billing/entitlements";

function setSolo(plan: string | null, subscription_status: string | null) {
  wsRow.value = { plan, organization_id: null, subscription_status, owner_id: "owner-1" };
  orgRow.value = null;
  siblingRows.value = [];
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

describe("resolveEntitlement: account-level sharing (a paid sibling lifts a free workspace)", () => {
  it("lifts a brand-new hobby workspace to the owner's paid plan on another workspace", async () => {
    // The bug repro: a freshly-created second workspace defaults to hobby, but
    // the SAME user has a paying Solo (pro) workspace → it inherits 'pro'.
    setSolo("hobby", null);
    siblingRows.value = [{ id: "ws-A", plan: "pro", subscription_status: "active" }];
    const e = await resolveEntitlement("ws");
    expect(e.plan).toBe("pro");
    expect(e.source).toBe("account");
    expect(e.organizationId).toBeNull();
  });

  it("picks the BEST active paid plan among the owner's workspaces", async () => {
    setSolo("hobby", null);
    siblingRows.value = [
      { id: "ws-A", plan: "pro", subscription_status: "active" },
      { id: "ws-B", plan: "founder", subscription_status: "active" },
    ];
    expect((await resolveEntitlement("ws")).plan).toBe("founder");
  });

  it("ignores a sibling whose subscription is non-paying", async () => {
    setSolo("hobby", null);
    siblingRows.value = [{ id: "ws-A", plan: "pro", subscription_status: "canceled" }];
    const e = await resolveEntitlement("ws");
    expect(e.plan).toBe("hobby");
    expect(e.source).toBe("workspace");
  });

  it("stays hobby when no sibling is on a paid plan", async () => {
    setSolo("hobby", null);
    siblingRows.value = [{ id: "ws-A", plan: "hobby", subscription_status: null }];
    expect((await resolveEntitlement("ws")).plan).toBe("hobby");
  });

  it("does NOT downgrade a workspace already on its own paid plan (no sibling read needed)", async () => {
    // This workspace pays for itself — account sharing only LIFTS, never lowers.
    setSolo("founder", "active");
    siblingRows.value = [{ id: "ws-A", plan: "pro", subscription_status: "active" }];
    const e = await resolveEntitlement("ws");
    expect(e.plan).toBe("founder");
    expect(e.source).toBe("workspace");
  });

  it("a workspace whose own sub lapsed still inherits a paying sibling's plan", async () => {
    // ws lapsed to hobby (unpaid), but the user has another paying workspace →
    // the account still covers it. Closes the gap where a lapsed primary would
    // otherwise strand an otherwise-covered secondary.
    setSolo("pro", "unpaid");
    siblingRows.value = [{ id: "ws-A", plan: "founder", subscription_status: "active" }];
    expect((await resolveEntitlement("ws")).plan).toBe("founder");
  });
});
