import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Unit: invite → client membership on signup (manage.ts) ────────────────────
//
// linkClientInvitesOnSignup is the bridge from a pending client_invite (035) to
// a client_membership (037). It runs SERVICE-ROLE only (the sole writer — there
// is no authenticated INSERT policy on client_memberships), matches invites by
// case-insensitive email, dedupes, and upserts idempotently. A signup with NO
// pending invite (the normal agency/solo case) writes nothing. Nothing here
// throws — a failure must never block signup.

const { inviteSelect, upsert } = vi.hoisted(() => ({
  inviteSelect: vi.fn(
    async (): Promise<{
      data: { workspace_id: string }[] | null;
      error: { message: string } | null;
    }> => ({ data: [], error: null }),
  ),
  upsert: vi.fn(
    async (
      _rows?: { user_id: string; workspace_id: string }[],
      _opts?: Record<string, unknown>,
    ): Promise<{ error: { message: string } | null }> => ({ error: null }),
  ),
}));

function makeServiceClient() {
  return {
    from: (table: string) => {
      if (table === "client_invites") {
        return { select: () => ({ ilike: inviteSelect }) };
      }
      if (table === "client_memberships") {
        return { upsert };
      }
      return {};
    },
  };
}

vi.mock("@/lib/supabase/service", () => ({ supabaseService: () => makeServiceClient() }));

import { linkClientInvitesOnSignup } from "@/lib/portal/manage";

beforeEach(() => {
  inviteSelect.mockResolvedValue({ data: [], error: null });
  upsert.mockResolvedValue({ error: null });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("linkClientInvitesOnSignup", () => {
  it("matches invites case-insensitively (lowercased email)", async () => {
    inviteSelect.mockResolvedValue({ data: [{ workspace_id: "ws-A" }], error: null });
    await linkClientInvitesOnSignup("u1", "  JANE@Client.CO ");
    expect(inviteSelect).toHaveBeenCalledWith("recipient_email", "jane@client.co");
  });

  it("writes NOTHING when there is no pending invite (agency/solo signup)", async () => {
    inviteSelect.mockResolvedValue({ data: [], error: null });
    const res = await linkClientInvitesOnSignup("u1", "founder@agency.co");
    expect(res.linkedWorkspaceIds).toEqual([]);
    expect(upsert).not.toHaveBeenCalled(); // no membership created for a non-client
  });

  it("dedupes repeated invites for the same workspace into ONE membership", async () => {
    inviteSelect.mockResolvedValue({
      data: [{ workspace_id: "ws-A" }, { workspace_id: "ws-A" }, { workspace_id: "ws-B" }],
      error: null,
    });
    const res = await linkClientInvitesOnSignup("u1", "jane@client.co");
    expect(res.linkedWorkspaceIds.sort()).toEqual(["ws-A", "ws-B"]);
    const rows = upsert.mock.calls[0]![0] as Array<{ user_id: string; workspace_id: string }>;
    expect(rows).toEqual([
      { user_id: "u1", workspace_id: "ws-A" },
      { user_id: "u1", workspace_id: "ws-B" },
    ]);
  });

  it("upserts idempotently (onConflict user_id,workspace_id, ignoreDuplicates)", async () => {
    inviteSelect.mockResolvedValue({ data: [{ workspace_id: "ws-A" }], error: null });
    await linkClientInvitesOnSignup("u1", "jane@client.co");
    const opts = upsert.mock.calls[0]![1] as Record<string, unknown>;
    expect(opts).toMatchObject({ onConflict: "user_id,workspace_id", ignoreDuplicates: true });
  });

  it("never throws + reports the error when the membership write fails", async () => {
    inviteSelect.mockResolvedValue({ data: [{ workspace_id: "ws-A" }], error: null });
    upsert.mockResolvedValue({ error: { message: "db down" } });
    const res = await linkClientInvitesOnSignup("u1", "jane@client.co");
    expect(res.error).toBe("db down");
    expect(res.linkedWorkspaceIds).toEqual([]);
  });

  it("never throws + reports the error when the invite lookup fails", async () => {
    inviteSelect.mockResolvedValue({ data: null, error: { message: "read fail" } });
    const res = await linkClientInvitesOnSignup("u1", "jane@client.co");
    expect(res.error).toBe("read fail");
    expect(upsert).not.toHaveBeenCalled();
  });
});
