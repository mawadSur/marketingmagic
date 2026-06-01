import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// ── Unit: weekly learning-digest cron route (graceful degrade + cold start) ──
//
// Drives the cron handler with mocked deps so NO Resend / DB call is live.
//   1. RESEND unset → 200 "not configured", NO network fetch, no throw.
//   2. unauthorized (bad/no Bearer) → 401.
//   3. cold-start workspace (assemble returns null) → skipped, no Resend send.
//   4. workspace with signal → owner email resolved + one Resend send.

let env = {
  CRON_SECRET: "secret-cron-key-1234",
  RESEND_API_KEY: "re_test_key_1234" as string | undefined,
  EMAIL_FROM: "noreply@x.app" as string | undefined,
};
vi.mock("@/lib/env", () => ({
  serverEnv: () => env,
  siteUrl: () => "https://app.test",
}));

// Supabase service stub: workspaces list + auth.admin.getUserById.
let workspaceRows: Array<{ id: string; name: string; owner_id: string }> = [];
const getUserById = vi.fn<(id: string) => unknown>();
vi.mock("@/lib/supabase/service", () => ({
  supabaseService: () => ({
    from: () => ({ select: () => ({ data: workspaceRows, error: null }) }),
    auth: { admin: { getUserById: (id: string) => getUserById(id) } },
  }),
}));

// Composer: control assemble (null = cold start) and the rendered HTML.
const assembleLearningDigest = vi.fn<(ws: string, opts: unknown) => unknown>();
const renderLearningDigest = vi.fn<(data: unknown) => string>(() => "<html>digest</html>");
vi.mock("@/lib/dashboard/learning-digest", () => ({
  assembleLearningDigest: (ws: string, opts: unknown) => assembleLearningDigest(ws, opts),
  renderLearningDigest: (data: unknown) => renderLearningDigest(data),
}));

import { POST } from "@/app/api/cron/learning-digest/route";

function req(auth = true): NextRequest {
  return new NextRequest("https://app.test/api/cron/learning-digest", {
    method: "POST",
    headers: auth ? { authorization: "Bearer secret-cron-key-1234" } : {},
  });
}

beforeEach(() => {
  env = {
    CRON_SECRET: "secret-cron-key-1234",
    RESEND_API_KEY: "re_test_key_1234",
    EMAIL_FROM: "noreply@x.app",
  };
  workspaceRows = [];
  getUserById.mockReset();
  assembleLearningDigest.mockReset();
  renderLearningDigest.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe("learning-digest cron — graceful degrade & gating", () => {
  it("RESEND unset → 200 not-configured, no network, no throw", async () => {
    env.RESEND_API_KEY = undefined;
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await POST(req());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.error).toMatch(/not configured/i);
    expect(fetchSpy).not.toHaveBeenCalled(); // never touched the network
    expect(assembleLearningDigest).not.toHaveBeenCalled();
  });

  it("EMAIL_FROM unset → 200 not-configured, no network", async () => {
    env.EMAIL_FROM = undefined;
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects an unauthorized request with 401", async () => {
    const res = await POST(req(false));
    expect(res.status).toBe(401);
  });

  it("cold-start workspace (assemble null) → skipped, no Resend send", async () => {
    workspaceRows = [{ id: "ws-cold", name: "Cold Co", owner_id: "u-cold" }];
    assembleLearningDigest.mockResolvedValue(null);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await POST(req());
    const body = await res.json();

    expect(body.sent).toBe(0);
    expect(body.skipped).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getUserById).not.toHaveBeenCalled(); // skip before resolving owner
  });

  it("workspace with signal → resolves owner + sends one Resend email", async () => {
    workspaceRows = [{ id: "ws-1", name: "Acme Co", owner_id: "u-1" }];
    assembleLearningDigest.mockResolvedValue({ workspaceName: "Acme Co" });
    getUserById.mockResolvedValue({ data: { user: { email: "owner@acme.co" } }, error: null });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    const res = await POST(req());
    const body = await res.json();

    expect(body.sent).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    const payload = JSON.parse((init as RequestInit).body as string);
    expect(payload.to).toBe("owner@acme.co");
    expect(payload.from).toBe("noreply@x.app");
    expect(payload.subject).toMatch(/What we learned & changed — Acme Co/);
  });
});
