import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Unit: client ACCOUNT report isolation (src/lib/portal/account.ts) ─────────
//
// SECURITY-CRITICAL. A logged-in client may read ONLY the aggregate report for a
// workspace they hold a client_membership for. These tests pin the two-layer
// gate:
//   1. resolveClientAccount reads client_memberships through the AUTHED client
//      (RLS scopes to auth.uid()) and never filters by a user id in code.
//   2. getClientWorkspaceReport re-asserts user_is_client_of(ws_id) via RPC
//      BEFORE any service-role report read; a workspace the caller isn't linked
//      to returns null — and NO posts/branding/analytics query runs.
//
// The user_is_client_of RPC takes ONLY { ws_id } (no user id) — the subject is
// always auth.uid(), so a client can't spoof membership of another workspace.

const {
  getUser,
  rpc,
  membershipSelect,
  workspaceServiceRows,
  getStatsByChannel,
  loadThemeWinners,
  postsSelect,
} = vi.hoisted(() => ({
  getUser: vi.fn(
    async (): Promise<{ data: { user: { id: string } | null } }> => ({
      data: { user: { id: "client-1" } },
    }),
  ),
  rpc: vi.fn(),
  // client_memberships rows the AUTHED client returns (already RLS-scoped to
  // the caller — the mock simply returns the caller's links).
  membershipSelect: vi.fn(async () => ({ data: [{ workspace_id: "ws-A" }] })),
  // service-role workspace name lookup.
  workspaceServiceRows: vi.fn(async () => ({ data: [{ id: "ws-A", name: "Client A" }] })),
  getStatsByChannel: vi.fn(async () => []),
  loadThemeWinners: vi.fn(async () => []),
  // service-role posts read inside the report builder — spied to PROVE it never
  // runs when the membership gate fails.
  postsSelect: vi.fn(async () => ({ data: [] })),
}));

// AUTHED server client: getUser, rpc (user_is_client_of), and a
// client_memberships select.
function makeServerClient() {
  return {
    auth: { getUser },
    rpc,
    from: (table: string) => {
      if (table === "client_memberships") {
        return { select: () => ({ order: membershipSelect }) };
      }
      // org_memberships / workspaces head-count probes (unused in these paths).
      return { select: () => ({}) };
    },
  };
}

// SERVICE-ROLE client: workspace name lookup + the report builder's reads. We
// spy posts.select so we can assert it is NEVER reached when the gate fails.
function makeServiceClient() {
  return {
    from: (table: string) => {
      if (table === "workspaces") {
        return {
          select: () => ({
            in: workspaceServiceRows, // resolveClientAccount name lookup
            eq: () => ({ maybeSingle: async () => ({ data: { name: "Client A", organization_id: null } }) }),
          }),
        };
      }
      if (table === "posts") {
        return {
          select: () => ({
            eq: () => ({
              in: () => ({
                order: () => ({ order: () => ({ limit: postsSelect }) }),
              }),
            }),
          }),
        };
      }
      if (table === "post_metrics") {
        return { select: () => ({ in: () => ({ order: async () => ({ data: [] }) }) }) };
      }
      return { select: () => ({}) };
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({ supabaseServer: async () => makeServerClient() }));
vi.mock("@/lib/supabase/service", () => ({ supabaseService: () => makeServiceClient() }));
vi.mock("@/lib/dashboard/analytics", () => ({ getStatsByChannel }));
vi.mock("@/lib/analytics/themes", () => ({ loadThemeWinners }));

import {
  resolveClientAccount,
  assertClientMembership,
  getClientWorkspaceReport,
} from "@/lib/portal/account";

beforeEach(() => {
  getUser.mockResolvedValue({ data: { user: { id: "client-1" } } });
  membershipSelect.mockResolvedValue({ data: [{ workspace_id: "ws-A" }] });
  workspaceServiceRows.mockResolvedValue({ data: [{ id: "ws-A", name: "Client A" }] });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("resolveClientAccount — only the caller's own memberships", () => {
  it("returns null for an unauthenticated caller (no client identity)", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    expect(await resolveClientAccount()).toBeNull();
  });

  it("returns null when the user has no client memberships (not a client)", async () => {
    membershipSelect.mockResolvedValue({ data: [] });
    expect(await resolveClientAccount()).toBeNull();
  });

  it("resolves exactly the workspaces the AUTHED client_memberships query returned", async () => {
    const account = await resolveClientAccount();
    expect(account).not.toBeNull();
    expect(account!.userId).toBe("client-1");
    expect(account!.workspaces).toEqual([{ workspaceId: "ws-A", workspaceName: "Client A" }]);
  });
});

describe("assertClientMembership — derives from auth.uid() (no spoofing)", () => {
  it("calls user_is_client_of with ONLY a ws_id (no user-id parameter)", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    await assertClientMembership("ws-A");
    expect(rpc).toHaveBeenCalledWith("user_is_client_of", { ws_id: "ws-A" });
    const args = rpc.mock.calls[0]![1] as Record<string, unknown>;
    expect(Object.keys(args)).toEqual(["ws_id"]); // no user id can be injected
  });

  it("is fail-closed when the RPC errors", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect(await assertClientMembership("ws-A")).toBe(false);
  });

  it("is false when the RPC returns false (not a client of ws)", async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    expect(await assertClientMembership("ws-A")).toBe(false);
  });
});

describe("getClientWorkspaceReport — membership gate precedes every read", () => {
  it("returns a report for a workspace the client IS linked to", async () => {
    rpc.mockResolvedValue({ data: true, error: null }); // user_is_client_of → true
    const data = await getClientWorkspaceReport("ws-A");
    expect(data).not.toBeNull();
    expect(data!.workspaceId).toBe("ws-A");
    expect(postsSelect).toHaveBeenCalled(); // report was actually built
  });

  it("CROSS-TENANT: returns null and reads NOTHING for a workspace the client is NOT linked to", async () => {
    rpc.mockResolvedValue({ data: false, error: null }); // user_is_client_of → false
    const data = await getClientWorkspaceReport("ws-OTHER");
    expect(data).toBeNull();
    // The gate must short-circuit BEFORE any service-role data read.
    expect(postsSelect).not.toHaveBeenCalled();
    expect(getStatsByChannel).not.toHaveBeenCalled();
    expect(loadThemeWinners).not.toHaveBeenCalled();
  });

  it("CROSS-TENANT: fail-closed when the gate RPC errors (no leak)", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect(await getClientWorkspaceReport("ws-A")).toBeNull();
    expect(postsSelect).not.toHaveBeenCalled();
  });
});
