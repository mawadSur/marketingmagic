import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// ── Unit: weekly-growth cron route — gating, idempotency, 429 posture ───────
//
// Drives the cron handler with mocked deps so NO Resend / DB / Claude call is
// live. Proves the Bet 5 invariants:
//   1. RESEND unset → 200 not-configured, no network, no throw.
//   2. unauthorized → 401.
//   3. IDEMPOTENCY: a workspace with an existing weekly_growth_runs row for the
//      window is skipped WITHOUT re-sending and WITHOUT re-assembling.
//   4. A fresh workspace → assemble → ONE narrative call → one Resend send →
//      one run record stamped (status 'sent').
//   5. DRAFT vs AUTO: the workspace's autopilot_mode is passed through to the
//      composer and snapshotted on the run record; NEITHER mode publishes /
//      replans / atomizes (the route only ever emails — there is no autonomous
//      action call site to fire).
//   6. cold-start (assemble null) → skipped + a 'skipped' run record, no send.

let env = {
  CRON_SECRET: "secret-cron-key-1234",
  RESEND_API_KEY: "re_test_key_1234" as string | undefined,
  EMAIL_FROM: "noreply@x.app" as string | undefined,
  ANTHROPIC_API_KEY: "sk-test",
};
vi.mock("@/lib/env", () => ({ serverEnv: () => env, siteUrl: () => "https://app.test" }));

// ── Supabase stub ───────────────────────────────────────────────────────────
// workspaces: select(...).limit(...) → { data: workspaceRows }
// weekly_growth_runs: SELECT path  → select.eq.eq.maybeSingle → existingRun
//                     INSERT path  → insert(row) → records.push(row)
// auth.admin.getUserById(id)       → getUserById(id)
let workspaceRows: Array<{ id: string; name: string; owner_id: string; autopilot_mode: string }> = [];
let existingRunByWorkspace: Record<string, { id: string; status: string } | null> = {};
const insertedRuns: Array<Record<string, unknown>> = [];
const getUserById = vi.fn<(id: string) => unknown>();

function workspacesBuilder() {
  const b: Record<string, unknown> = {};
  b.select = () => b;
  b.limit = () => Promise.resolve({ data: workspaceRows, error: null });
  return b;
}

function runsBuilder() {
  // SELECT chain captures the workspace id from the first .eq, resolves on
  // .maybeSingle. INSERT resolves immediately and records the row.
  let wsId = "";
  const b: Record<string, unknown> = {};
  b.select = () => b;
  b.eq = (col: string, val: string) => {
    if (col === "workspace_id") wsId = val;
    return b;
  };
  b.maybeSingle = () => Promise.resolve({ data: existingRunByWorkspace[wsId] ?? null, error: null });
  b.insert = (row: Record<string, unknown>) => {
    insertedRuns.push(row);
    return Promise.resolve({ error: null });
  };
  return b;
}

vi.mock("@/lib/supabase/service", () => ({
  supabaseService: () => ({
    from: (table: string) => (table === "workspaces" ? workspacesBuilder() : runsBuilder()),
    auth: { admin: { getUserById: (id: string) => getUserById(id) } },
  }),
}));

// ── Composer / renderer / narrative mocks ────────────────────────────────────
const assembleWeeklyDigest = vi.fn<(ws: string, opts: { mode: string }) => unknown>();
const generateWeeklyNarrative = vi.fn<(d: unknown) => Promise<string>>();
const renderWeeklyGrowthDigest = vi.fn<(d: unknown) => string>(() => "<html>weekly</html>");
vi.mock("@/lib/growth/weekly-digest", async () => {
  const actual = await vi.importActual<typeof import("@/lib/growth/weekly-digest")>(
    "@/lib/growth/weekly-digest",
  );
  return {
    ...actual, // keep the real cycleWindowStart
    assembleWeeklyDigest: (ws: string, opts: { mode: string }) => assembleWeeklyDigest(ws, opts),
    generateWeeklyNarrative: (d: unknown) => generateWeeklyNarrative(d),
  };
});
vi.mock("@/lib/growth/weekly-digest-html", () => ({
  renderWeeklyGrowthDigest: (d: unknown) => renderWeeklyGrowthDigest(d),
}));

import { POST } from "@/app/api/cron/weekly-growth/route";

// A minimal assembled-digest shape (the composer is mocked, so shape is loose).
function digest(mode: "draft" | "auto" = "draft") {
  return {
    workspaceName: "Acme Co",
    mode,
    shipped: { posts: 4, impressions: 1200, engagements: 90 },
    revenueCents: 50000,
    themeRevenue: [],
    winners: [],
    community: { autoRepliesSent: 1, dmsSent: 0, leadsTagged: 0, blockedOrFailed: 0 },
    recommendedThemes: ["pricing"],
  };
}

function req(auth = true): NextRequest {
  return new NextRequest("https://app.test/api/cron/weekly-growth", {
    method: "POST",
    headers: auth ? { authorization: "Bearer secret-cron-key-1234" } : {},
  });
}

beforeEach(() => {
  env = {
    CRON_SECRET: "secret-cron-key-1234",
    RESEND_API_KEY: "re_test_key_1234",
    EMAIL_FROM: "noreply@x.app",
    ANTHROPIC_API_KEY: "sk-test",
  };
  workspaceRows = [];
  existingRunByWorkspace = {};
  insertedRuns.length = 0;
  getUserById.mockReset();
  assembleWeeklyDigest.mockReset();
  generateWeeklyNarrative.mockReset().mockResolvedValue("the week in a sentence");
  renderWeeklyGrowthDigest.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe("weekly-growth cron — graceful degrade & auth", () => {
  it("RESEND unset → 200 not-configured, no network", async () => {
    env.RESEND_API_KEY = undefined;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await POST(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.error).toMatch(/not configured/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(assembleWeeklyDigest).not.toHaveBeenCalled();
  });

  it("unauthorized → 401", async () => {
    const res = await POST(req(false));
    expect(res.status).toBe(401);
  });
});

describe("weekly-growth cron — idempotency (never double-send a window)", () => {
  it("skips a workspace that already has a run record for this window", async () => {
    workspaceRows = [{ id: "ws-1", name: "Acme Co", owner_id: "u-1", autopilot_mode: "draft" }];
    existingRunByWorkspace = { "ws-1": { id: "run-1", status: "sent" } };
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await POST(req());
    const body = await res.json();

    expect(body.skipped).toBe(1);
    expect(body.sent).toBe(0);
    expect(assembleWeeklyDigest).not.toHaveBeenCalled(); // short-circuits before assembly
    expect(generateWeeklyNarrative).not.toHaveBeenCalled(); // and before any model call
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(insertedRuns).toHaveLength(0); // no duplicate record written
  });
});

describe("weekly-growth cron — send + record + draft/auto gating", () => {
  it("fresh workspace → assemble, ONE narrative call, one send, one 'sent' record", async () => {
    workspaceRows = [{ id: "ws-1", name: "Acme Co", owner_id: "u-1", autopilot_mode: "draft" }];
    assembleWeeklyDigest.mockResolvedValue(digest("draft"));
    getUserById.mockResolvedValue({ data: { user: { email: "owner@acme.co" } }, error: null });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    const res = await POST(req());
    const body = await res.json();

    expect(body.sent).toBe(1);
    // windowStart is derived from the real `now` (the cron's clock) — assert
    // it's a Monday ISO date rather than hard-coding a date the test can't fix.
    expect(body.windowStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // exactly ONE Claude narrative call for the workspace (429 posture)
    expect(generateWeeklyNarrative).toHaveBeenCalledTimes(1);
    // exactly ONE Resend send
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    const payload = JSON.parse((init as RequestInit).body as string);
    expect(payload.to).toBe("owner@acme.co");
    expect(payload.subject).toMatch(/Your weekly growth recap — Acme Co/);
    // one run record stamped 'sent', mode snapshotted as draft
    expect(insertedRuns).toHaveLength(1);
    expect(insertedRuns[0]!.status).toBe("sent");
    expect(insertedRuns[0]!.mode).toBe("draft");
  });

  it("passes the workspace autopilot_mode through to the composer (auto)", async () => {
    workspaceRows = [{ id: "ws-2", name: "Auto Co", owner_id: "u-2", autopilot_mode: "auto" }];
    assembleWeeklyDigest.mockResolvedValue(digest("auto"));
    getUserById.mockResolvedValue({ data: { user: { email: "owner@auto.co" } }, error: null });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    await POST(req());

    // mode reached the composer + got snapshotted; the route NEVER calls any
    // publish/replan/atomize path — it only ever emails (no such call site
    // exists in the route), so auto mode is wired but takes no autonomous action.
    expect(assembleWeeklyDigest).toHaveBeenCalledWith("ws-2", expect.objectContaining({ mode: "auto" }));
    expect(insertedRuns[0]!.mode).toBe("auto");
  });

  it("unknown autopilot_mode is treated as draft (conservative default)", async () => {
    workspaceRows = [{ id: "ws-x", name: "Legacy Co", owner_id: "u-x", autopilot_mode: "weird" }];
    assembleWeeklyDigest.mockResolvedValue(digest("draft"));
    getUserById.mockResolvedValue({ data: { user: { email: "owner@x.co" } }, error: null });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    await POST(req());
    expect(assembleWeeklyDigest).toHaveBeenCalledWith("ws-x", expect.objectContaining({ mode: "draft" }));
    expect(insertedRuns[0]!.mode).toBe("draft");
  });

  it("cold-start (assemble null) → skipped + a 'skipped' record, no send", async () => {
    workspaceRows = [{ id: "ws-cold", name: "Cold Co", owner_id: "u-cold", autopilot_mode: "draft" }];
    assembleWeeklyDigest.mockResolvedValue(null);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await POST(req());
    const body = await res.json();

    expect(body.skipped).toBe(1);
    expect(body.sent).toBe(0);
    expect(generateWeeklyNarrative).not.toHaveBeenCalled(); // no model spend on cold start
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getUserById).not.toHaveBeenCalled(); // skip before resolving owner
    // a 'skipped' record IS stamped so we don't re-evaluate this window
    expect(insertedRuns).toHaveLength(1);
    expect(insertedRuns[0]!.status).toBe("skipped");
  });

  it("processes multiple workspaces sequentially — one narrative call each", async () => {
    workspaceRows = [
      { id: "ws-1", name: "A", owner_id: "u-1", autopilot_mode: "draft" },
      { id: "ws-2", name: "B", owner_id: "u-2", autopilot_mode: "draft" },
    ];
    assembleWeeklyDigest.mockResolvedValue(digest());
    getUserById.mockResolvedValue({ data: { user: { email: "x@y.co" } }, error: null });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    const res = await POST(req());
    const body = await res.json();

    expect(body.sent).toBe(2);
    expect(generateWeeklyNarrative).toHaveBeenCalledTimes(2); // one per workspace, not a fan-out
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(insertedRuns).toHaveLength(2);
  });
});
