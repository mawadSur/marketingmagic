import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Unit: org billing re-sync authorization (billing/resync-action.ts) ────────
//
// Re-syncing the org's Stripe seat quantity moves real money (Stripe prorates),
// so it is an ORG-ADMIN-ONLY action: owner or 'admin' org_membership role. A
// 'manager' member or a non-member must be rejected and crucially must NEVER
// reach syncOrgSubscriptionQuantity (no privilege escalation, no Stripe mutation
// on an unauthorized request).
//
// The action proves admin via the user_is_org_admin(org_id) RPC under the
// caller's auth session (SECURITY DEFINER, owner-or-'admin'). We mock the
// Supabase server client to drive the RPC result and assert exactly whether the
// Stripe sync was attempted.

const { rpc, getUser, syncOrgSubscriptionQuantity, revalidatePath } = vi.hoisted(() => ({
  rpc: vi.fn(),
  getUser: vi.fn(
    async (): Promise<{ data: { user: { id: string } | null } }> => ({
      data: { user: { id: "user-admin" } },
    }),
  ),
  syncOrgSubscriptionQuantity: vi.fn(async () => {}),
  revalidatePath: vi.fn(),
}));

function makeServerClient() {
  return { auth: { getUser }, rpc };
}

vi.mock("@/lib/supabase/server", () => ({ supabaseServer: async () => makeServerClient() }));
vi.mock("@/lib/billing/org-subscription", () => ({ syncOrgSubscriptionQuantity }));
vi.mock("next/cache", () => ({ revalidatePath }));

import { resyncOrgQuantityAction } from "@/app/(app)/settings/organization/billing/resync-action";

const ORG_ID = "11111111-1111-4111-8111-111111111111";

function form(organizationId: string): FormData {
  const fd = new FormData();
  fd.set("organization_id", organizationId);
  return fd;
}

beforeEach(() => {
  getUser.mockResolvedValue({ data: { user: { id: "user-admin" } } });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("resyncOrgQuantityAction — org-admin-only authorization", () => {
  it("rejects a non-admin (manager) and never touches Stripe", async () => {
    rpc.mockResolvedValue({ data: false, error: null }); // user_is_org_admin → false

    const res = await resyncOrgQuantityAction({ error: null, ok: false }, form(ORG_ID));

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/admin/i);
    expect(rpc).toHaveBeenCalledWith("user_is_org_admin", { org_id: ORG_ID });
    expect(syncOrgSubscriptionQuantity).not.toHaveBeenCalled(); // no escalation
  });

  it("rejects when the authz RPC errors (fail-closed)", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });

    const res = await resyncOrgQuantityAction({ error: null, ok: false }, form(ORG_ID));

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/admin/i);
    expect(syncOrgSubscriptionQuantity).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller before the RPC", async () => {
    getUser.mockResolvedValue({ data: { user: null } });

    const res = await resyncOrgQuantityAction({ error: null, ok: false }, form(ORG_ID));

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/signed in/i);
    expect(rpc).not.toHaveBeenCalled();
    expect(syncOrgSubscriptionQuantity).not.toHaveBeenCalled();
  });

  it("rejects an invalid (non-uuid) org id before any DB/RPC call", async () => {
    const res = await resyncOrgQuantityAction({ error: null, ok: false }, form("not-a-uuid"));

    expect(res.ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
    expect(syncOrgSubscriptionQuantity).not.toHaveBeenCalled();
  });

  it("allows an admin and runs the Stripe sync exactly once", async () => {
    rpc.mockResolvedValue({ data: true, error: null }); // user_is_org_admin → true

    const res = await resyncOrgQuantityAction({ error: null, ok: false }, form(ORG_ID));

    expect(res.ok).toBe(true);
    expect(res.error).toBeNull();
    expect(syncOrgSubscriptionQuantity).toHaveBeenCalledTimes(1);
    expect(syncOrgSubscriptionQuantity).toHaveBeenCalledWith(ORG_ID);
    expect(revalidatePath).toHaveBeenCalled();
  });

  it("surfaces a Stripe failure to the operator (does not swallow)", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    syncOrgSubscriptionQuantity.mockRejectedValueOnce(new Error("stripe down"));

    const res = await resyncOrgQuantityAction({ error: null, ok: false }, form(ORG_ID));

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/stripe down/i);
  });
});
