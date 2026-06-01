import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Unit: add-client authorization (settings/organization/actions.ts) ─────────
//
// Adding a client workspace under an org bumps the billed seat count, so it is
// an ORG-ADMIN-ONLY action: owner or 'admin' org_membership role. A 'manager'
// member or a non-member must be rejected, and crucially NO workspace row may
// be inserted when the gate fails (no privilege escalation, no orphan client).
//
// The action proves admin via the user_is_org_admin(org_id) RPC, evaluated
// under the caller's auth session (SECURITY DEFINER, owner-or-'admin'). We mock
// the Supabase server client so we can drive the RPC result and assert exactly
// whether a `workspaces` insert was attempted.

// vi.mock factories are hoisted above normal `const`s, so the mock fns must be
// created with vi.hoisted to be referenceable inside them.
const {
  rpc,
  insert,
  fromSelectMaybeSingle,
  getUser,
  setActiveWorkspaceCookie,
  syncOrgSubscriptionQuantitySafe,
  revalidatePath,
  redirect,
} = vi.hoisted(() => ({
  rpc: vi.fn(),
  insert: vi.fn((_row: Record<string, unknown>) => ({ error: null })),
  fromSelectMaybeSingle: vi.fn(async () => ({ data: null })),
  getUser: vi.fn(
    async (): Promise<{ data: { user: { id: string } | null } }> => ({
      data: { user: { id: "user-admin" } },
    }),
  ),
  setActiveWorkspaceCookie: vi.fn(async () => {}),
  syncOrgSubscriptionQuantitySafe: vi.fn(async () => {}),
  revalidatePath: vi.fn(),
  // Next's redirect throws to unwind; mirror that so the success path stops
  // exactly where the real action would.
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));

// A `.from(table)` query builder. For `workspaces` we record inserts; the slug
// uniqueness probe (service client) returns no row so the first candidate wins.
function makeServerClient() {
  return {
    auth: { getUser },
    rpc,
    from: (table: string) => {
      if (table === "workspaces") {
        return {
          insert,
          select: () => ({
            eq: () => ({ maybeSingle: fromSelectMaybeSingle }),
          }),
        };
      }
      // organizations / fallthrough
      return {
        select: () => ({ eq: () => ({ maybeSingle: fromSelectMaybeSingle }) }),
      };
    },
  };
}

function makeServiceClient() {
  // Used only by the slug helper: always "slug is free".
  return {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
  };
}

vi.mock("@/lib/supabase/server", () => ({ supabaseServer: async () => makeServerClient() }));
vi.mock("@/lib/supabase/service", () => ({ supabaseService: () => makeServiceClient() }));
vi.mock("@/lib/workspace", () => ({ setActiveWorkspaceCookie }));
vi.mock("@/lib/billing/org-subscription", () => ({ syncOrgSubscriptionQuantitySafe }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/navigation", () => ({ redirect }));

import { addClientAction } from "@/app/(app)/settings/organization/actions";

const ORG_ID = "11111111-1111-4111-8111-111111111111";

function form(name: string, organizationId: string): FormData {
  const fd = new FormData();
  fd.set("name", name);
  fd.set("organization_id", organizationId);
  return fd;
}

beforeEach(() => {
  getUser.mockResolvedValue({ data: { user: { id: "user-admin" } } });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("addClientAction — org-admin-only authorization", () => {
  it("rejects a non-admin (manager) and inserts NO workspace", async () => {
    rpc.mockResolvedValue({ data: false, error: null }); // user_is_org_admin → false

    const res = await addClientAction({ error: null }, form("Client Co", ORG_ID));

    expect(res.error).toMatch(/admin/i);
    expect(rpc).toHaveBeenCalledWith("user_is_org_admin", { org_id: ORG_ID });
    expect(insert).not.toHaveBeenCalled(); // no privilege escalation
    expect(redirect).not.toHaveBeenCalled();
  });

  it("rejects when the authz RPC errors (fail-closed)", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });

    const res = await addClientAction({ error: null }, form("Client Co", ORG_ID));

    expect(res.error).toMatch(/admin/i);
    expect(insert).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller before touching the RPC", async () => {
    getUser.mockResolvedValue({ data: { user: null } });

    const res = await addClientAction({ error: null }, form("Client Co", ORG_ID));

    expect(res.error).toMatch(/signed in/i);
    expect(rpc).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("allows an admin and inserts a workspace bound to the org", async () => {
    rpc.mockResolvedValue({ data: true, error: null }); // user_is_org_admin → true

    // redirect() throws (NEXT_REDIRECT) on success — catch it and assert the
    // insert that ran before it.
    await expect(
      addClientAction({ error: null }, form("Client Co", ORG_ID)),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(insert).toHaveBeenCalledTimes(1);
    const inserted = insert.mock.calls[0]![0] as unknown as {
      organization_id: string;
      owner_id: string;
      name: string;
    };
    expect(inserted.organization_id).toBe(ORG_ID); // → inherits org plan via entitlements
    expect(inserted.owner_id).toBe("user-admin");
    expect(inserted.name).toBe("Client Co");
    // A new client = one more billed seat; the quantity sync is invoked.
    expect(syncOrgSubscriptionQuantitySafe).toHaveBeenCalledWith(ORG_ID);
  });

  it("rejects an invalid (non-uuid) organization id before any DB/RPC call", async () => {
    const res = await addClientAction({ error: null }, form("Client Co", "not-a-uuid"));
    expect(res.error).toBeTruthy();
    expect(rpc).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });
});
