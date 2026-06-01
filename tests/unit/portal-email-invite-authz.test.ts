import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Unit: email-invite authorization (branding/actions.ts emailInviteAction) ──
//
// Emailing a client their portal link is an ORG-ADMIN-ONLY action: owner or
// 'admin' org_membership role. A 'manager' member or a non-member must be
// rejected and crucially must NEVER reach the email sender or the audit-insert
// (no privilege escalation, no email sent on an unauthorized request).
//
// The action proves admin via the user_is_org_admin(org_id) RPC under the
// caller's session. We mock the Supabase server client (RPC + workspace/org
// reads), the token resolver, and the email sender so we can assert exactly
// whether a send was attempted.

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const WS_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN = "abcdefghijklmnopqrstuvwxyz012345"; // 32 chars, matches RAW_TOKEN_RE
const PORTAL_URL = `https://app.example.com/client/${TOKEN}`;

const {
  rpc,
  getUser,
  resolvePortalToken,
  sendInviteEmail,
  recordClientInvite,
  renderInviteEmail,
  revalidatePath,
  wsMaybeSingle,
  orgMaybeSingle,
} = vi.hoisted(() => ({
  rpc: vi.fn(),
  getUser: vi.fn(
    async (): Promise<{ data: { user: { id: string } | null } }> => ({
      data: { user: { id: "user-admin" } },
    }),
  ),
  resolvePortalToken: vi.fn(),
  sendInviteEmail: vi.fn(
    async (): Promise<
      | { status: "sent" }
      | { status: "skipped"; reason: string }
      | { status: "failed"; reason: string }
    > => ({ status: "sent" }),
  ),
  recordClientInvite: vi.fn(async () => ({ error: null })),
  renderInviteEmail: vi.fn(() => ({ subject: "s", html: "h", text: "t" })),
  revalidatePath: vi.fn(),
  wsMaybeSingle: vi.fn(
    async (): Promise<{
      data: { id: string; name: string; organization_id: string } | null;
    }> => ({ data: { id: WS_ID, name: "Client Co", organization_id: ORG_ID } }),
  ),
  orgMaybeSingle: vi.fn(
    async (): Promise<{
      data: { name: string; logo_url: string | null; color_accent: string | null } | null;
    }> => ({ data: { name: "Agency", logo_url: null, color_accent: null } }),
  ),
}));

// Server client: rpc for authz, and `.from(table).select().eq().maybeSingle()`
// returning the workspace row (org membership check) then the org row.
function makeServerClient() {
  return {
    auth: { getUser },
    rpc,
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: table === "workspaces" ? wsMaybeSingle : orgMaybeSingle,
        }),
      }),
    }),
  };
}

vi.mock("@/lib/supabase/server", () => ({ supabaseServer: async () => makeServerClient() }));
vi.mock("@/lib/supabase/service", () => ({ supabaseService: () => ({}) }));
vi.mock("@/lib/portal/token", () => ({ resolvePortalToken }));
vi.mock("@/lib/portal/invite-email", () => ({ renderInviteEmail, sendInviteEmail }));
vi.mock("@/lib/portal/manage", () => ({
  recordClientInvite,
  // unused by this action but imported by the module under test:
  mintPortalToken: vi.fn(),
  revokePortalToken: vi.fn(),
}));
vi.mock("@/lib/portal/branding", () => ({
  ORG_BRANDING_BUCKET: "org-branding",
  ALLOWED_LOGO_MIME: ["image/png"],
  logoExtForMime: () => "png",
}));
vi.mock("@/lib/env", () => ({ siteUrl: () => "https://app.example.com" }));
vi.mock("next/cache", () => ({ revalidatePath }));

import { emailInviteAction } from "@/app/(app)/settings/organization/branding/actions";

function form(over: Partial<Record<string, string>> = {}): FormData {
  const fd = new FormData();
  fd.set("organization_id", over.organization_id ?? ORG_ID);
  fd.set("recipient", over.recipient ?? "jane@client.co");
  fd.set("portal_url", over.portal_url ?? PORTAL_URL);
  return fd;
}

beforeEach(() => {
  getUser.mockResolvedValue({ data: { user: { id: "user-admin" } } });
  resolvePortalToken.mockResolvedValue({
    tokenId: "33333333-3333-4333-8333-333333333333",
    workspaceId: WS_ID,
    scopes: ["approve", "view_reports"],
    label: null,
  });
  wsMaybeSingle.mockResolvedValue({
    data: { id: WS_ID, name: "Client Co", organization_id: ORG_ID },
  });
  sendInviteEmail.mockResolvedValue({ status: "sent" });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("emailInviteAction — org-admin-only authorization", () => {
  it("rejects a non-admin (manager): no email sent, no audit row", async () => {
    rpc.mockResolvedValue({ data: false, error: null }); // user_is_org_admin → false

    const res = await emailInviteAction({ error: null, status: null }, form());

    expect(res.status).toBeNull();
    expect(res.error).toMatch(/admin/i);
    expect(sendInviteEmail).not.toHaveBeenCalled(); // no escalation
    expect(recordClientInvite).not.toHaveBeenCalled();
  });

  it("rejects when the authz RPC errors (fail-closed)", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });

    const res = await emailInviteAction({ error: null, status: null }, form());

    expect(res.error).toMatch(/admin/i);
    expect(sendInviteEmail).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller before the RPC", async () => {
    getUser.mockResolvedValue({ data: { user: null } });

    const res = await emailInviteAction({ error: null, status: null }, form());

    expect(res.error).toMatch(/admin/i);
    expect(rpc).not.toHaveBeenCalled();
    expect(sendInviteEmail).not.toHaveBeenCalled();
  });

  it("rejects a token whose workspace is in a DIFFERENT org (no cross-org email)", async () => {
    rpc.mockResolvedValue({ data: true, error: null }); // admin of THIS org
    wsMaybeSingle.mockResolvedValue({
      data: { id: WS_ID, name: "Other", organization_id: "99999999-9999-4999-8999-999999999999" },
    });

    const res = await emailInviteAction({ error: null, status: null }, form());

    expect(res.error).toMatch(/your organization/i);
    expect(sendInviteEmail).not.toHaveBeenCalled();
  });

  it("rejects a non-portal URL before resolving any token", async () => {
    rpc.mockResolvedValue({ data: true, error: null });

    const res = await emailInviteAction(
      { error: null, status: null },
      form({ portal_url: "https://app.example.com/dashboard" }),
    );

    expect(res.error).toMatch(/portal link/i);
    expect(resolvePortalToken).not.toHaveBeenCalled();
    expect(sendInviteEmail).not.toHaveBeenCalled();
  });

  it("allows an admin: sends the email and records the audit row", async () => {
    rpc.mockResolvedValue({ data: true, error: null });

    const res = await emailInviteAction({ error: null, status: null }, form());

    expect(res.error).toBeNull();
    expect(res.status).toBe("sent");
    expect(sendInviteEmail).toHaveBeenCalledOnce();
    expect(sendInviteEmail).toHaveBeenCalledWith(
      "jane@client.co",
      expect.objectContaining({ subject: expect.any(String) }),
    );
    expect(recordClientInvite).toHaveBeenCalledOnce();
  });

  it("on a SKIPPED send (email unconfigured) does NOT record an audit row", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    sendInviteEmail.mockResolvedValue({ status: "skipped", reason: "email_not_configured" });

    const res = await emailInviteAction({ error: null, status: null }, form());

    expect(res.status).toBe("skipped");
    expect(res.error).toBeNull();
    expect(recordClientInvite).not.toHaveBeenCalled(); // nobody actually got an email
  });
});
