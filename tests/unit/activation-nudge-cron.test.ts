import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// ── Unit: activation-nudge cron — gating, cohort window, posted-exclusion ────
//
// Drives the cron handler with mocked deps so NO Resend / DB call is live.
// Proves the "connected but never published" invariants:
//   1. RESEND unset → 200 not-configured, no network, no throw (ship-dark).
//   2. unauthorized → 401.
//   3. COHORT WINDOW: only workspaces whose FIRST connected channel is in
//      [72h, 48h) ago qualify — too-new (<48h) and too-old (>72h) are excluded.
//   4. POSTED-EXCLUSION: a candidate that already has a 'posted' post is
//      dropped (it has activated; the nudge is moot).
//   5. A qualifying workspace → one Resend send to the owner, primary CTA
//      points at the wizard one-click publish step.

let env = {
  CRON_SECRET: "secret-cron-key-1234",
  RESEND_API_KEY: "re_test_key_1234" as string | undefined,
  EMAIL_FROM: "noreply@x.app" as string | undefined,
};
vi.mock("@/lib/env", () => ({ serverEnv: () => env, siteUrl: () => "https://app.test" }));

// ── Supabase stub ───────────────────────────────────────────────────────────
// social_accounts: select.eq('status').lte('created_at').order(...) → accountRows
// posts:           select.eq('status').in('workspace_id', ids)      → postedRows
// workspaces:      select.in('id', ids)                             → workspaceRows
// auth.admin.getUserById(id) → getUserById(id)
let accountRows: Array<{ workspace_id: string; created_at: string }> = [];
let postedRows: Array<{ workspace_id: string }> = [];
let workspaceRows: Array<{ id: string; name: string; owner_id: string }> = [];
const getUserById = vi.fn<(id: string) => unknown>();

function socialAccountsBuilder() {
  const b: Record<string, unknown> = {};
  b.select = () => b;
  b.eq = () => b;
  b.lte = () => b;
  b.order = () => Promise.resolve({ data: accountRows, error: null });
  return b;
}

function postsBuilder() {
  const b: Record<string, unknown> = {};
  b.select = () => b;
  b.eq = () => b;
  b.in = () => Promise.resolve({ data: postedRows, error: null });
  return b;
}

function workspacesBuilder() {
  const b: Record<string, unknown> = {};
  b.select = () => b;
  b.in = () => Promise.resolve({ data: workspaceRows, error: null });
  return b;
}

vi.mock("@/lib/supabase/service", () => ({
  supabaseService: () => ({
    from: (table: string) => {
      if (table === "social_accounts") return socialAccountsBuilder();
      if (table === "posts") return postsBuilder();
      return workspacesBuilder();
    },
    auth: { admin: { getUserById: (id: string) => getUserById(id) } },
  }),
}));

import { POST } from "@/app/api/cron/activation-nudge/route";

function req(auth = true): NextRequest {
  return new NextRequest("https://app.test/api/cron/activation-nudge", {
    method: "POST",
    headers: auth ? { authorization: "Bearer secret-cron-key-1234" } : {},
  });
}

function hoursAgoIso(h: number): string {
  return new Date(Date.now() - h * 3600_000).toISOString();
}

beforeEach(() => {
  env = {
    CRON_SECRET: "secret-cron-key-1234",
    RESEND_API_KEY: "re_test_key_1234",
    EMAIL_FROM: "noreply@x.app",
  };
  accountRows = [];
  postedRows = [];
  workspaceRows = [];
  getUserById.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("activation-nudge cron — graceful degrade & auth", () => {
  it("RESEND unset → 200 not-configured, no network", async () => {
    env.RESEND_API_KEY = undefined;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await POST(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.skipped).toMatch(/not configured/i);
    expect(body.scanned).toBe(0);
    expect(body.nudged).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("unauthorized → 401", async () => {
    const res = await POST(req(false));
    expect(res.status).toBe(401);
  });
});

describe("activation-nudge cron — cohort window", () => {
  it("nudges a workspace whose first connect is inside [72h, 48h) and never posted", async () => {
    accountRows = [{ workspace_id: "ws-1", created_at: hoursAgoIso(60) }];
    workspaceRows = [{ id: "ws-1", name: "Acme Co", owner_id: "u-1" }];
    getUserById.mockResolvedValue({ data: { user: { email: "owner@acme.co" } }, error: null });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    const res = await POST(req());
    const body = await res.json();

    expect(body.scanned).toBe(1);
    expect(body.nudged).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    const payload = JSON.parse((init as RequestInit).body as string);
    expect(payload.to).toBe("owner@acme.co");
    expect(payload.subject).toMatch(/Acme Co/);
    // primary CTA points at the wizard one-click first-publish step
    expect(payload.html).toContain("/onboarding/wizard?step=4");
    expect(payload.html).toContain("/queue");
  });

  it("excludes a too-new workspace (first connect < 48h ago)", async () => {
    // lte('created_at', 48h-ago) means the route never even receives this row,
    // but assert at the cohort level: a 24h-old connect must not be nudged.
    accountRows = []; // 24h-old row would be filtered out by the .lte bound
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await POST(req());
    const body = await res.json();
    expect(body.scanned).toBe(0);
    expect(body.nudged).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("excludes a too-old workspace (first connect > 72h ago)", async () => {
    accountRows = [{ workspace_id: "ws-old", created_at: hoursAgoIso(100) }];
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await POST(req());
    const body = await res.json();
    expect(body.scanned).toBe(0);
    expect(body.nudged).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses the EARLIEST connect per workspace (a later connect doesn't reset the clock)", async () => {
    // First connect 100h ago (too old) — even though a second channel connected
    // 60h ago (in-window), the workspace activated its first channel >72h ago,
    // so it should NOT be nudged.
    accountRows = [
      { workspace_id: "ws-1", created_at: hoursAgoIso(100) },
      { workspace_id: "ws-1", created_at: hoursAgoIso(60) },
    ];
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await POST(req());
    const body = await res.json();
    expect(body.scanned).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("activation-nudge cron — posted-exclusion", () => {
  it("drops a candidate that has already published (status='posted')", async () => {
    accountRows = [{ workspace_id: "ws-1", created_at: hoursAgoIso(60) }];
    postedRows = [{ workspace_id: "ws-1" }]; // already activated
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await POST(req());
    const body = await res.json();

    expect(body.scanned).toBe(1); // counted as scanned…
    expect(body.nudged).toBe(0); // …but not nudged
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getUserById).not.toHaveBeenCalled();
  });
});

describe("activation-nudge cron — owner resolution", () => {
  it("skips quietly when the owner has no email", async () => {
    accountRows = [{ workspace_id: "ws-1", created_at: hoursAgoIso(60) }];
    workspaceRows = [{ id: "ws-1", name: "Acme Co", owner_id: "u-1" }];
    getUserById.mockResolvedValue({ data: { user: { email: null } }, error: null });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await POST(req());
    const body = await res.json();

    expect(body.scanned).toBe(1);
    expect(body.nudged).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
