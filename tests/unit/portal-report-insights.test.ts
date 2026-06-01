import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Unit: client report insights (src/lib/portal/data.ts getPortalInsights) ──
//
// The client performance report's substance: per-channel breakdown (30d) +
// winning themes. getPortalInsights wraps the EXISTING dashboard/theme analytics
// and must:
//   1. hard-gate on the 'view_reports' scope (throw PortalScopeError otherwise),
//   2. pass ONLY ctx.workspaceId into the reused analytics — never a value the
//      caller controls — so the portal can never read another workspace.
//
// We mock the two reused analytics modules so we can assert exactly which
// workspaceId they were called with (the cross-workspace-isolation guarantee)
// without touching a real DB.

const getStatsByChannel = vi.fn();
const loadThemeWinners = vi.fn();

vi.mock("@/lib/dashboard/analytics", () => ({
  getStatsByChannel: (...args: unknown[]) => getStatsByChannel(...args),
}));
vi.mock("@/lib/analytics/themes", () => ({
  loadThemeWinners: (...args: unknown[]) => loadThemeWinners(...args),
}));
// data.ts imports supabaseService at module scope for its other functions; the
// insights path never calls it, but the import must resolve.
vi.mock("@/lib/supabase/service", () => ({ supabaseService: () => ({}) }));

import { getPortalInsights } from "@/lib/portal/data";
import { PortalScopeError, type PortalContext } from "@/lib/portal/token";

function ctxWith(scopes: PortalContext["scopes"], workspaceId = "ws-A"): PortalContext {
  return Object.freeze({
    tokenId: "tok-1",
    workspaceId,
    scopes,
    label: null,
  });
}

beforeEach(() => {
  getStatsByChannel.mockResolvedValue([
    { channel: "x", posts: 4, impressions: 1000, engagement: 50, engagement_rate: 0.05 },
  ]);
  loadThemeWinners.mockResolvedValue([
    { tag: "founder-story", posterior_mean: 0.08, ci_low: 0.06, ci_high: 0.1, posts: 6, lift: 1.6 },
  ]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("getPortalInsights", () => {
  it("throws without the view_reports scope (never reads data)", async () => {
    await expect(getPortalInsights(ctxWith(["approve"]))).rejects.toBeInstanceOf(PortalScopeError);
    expect(getStatsByChannel).not.toHaveBeenCalled();
    expect(loadThemeWinners).not.toHaveBeenCalled();
  });

  it("scopes both analytics to ctx.workspaceId only (cross-workspace isolation)", async () => {
    await getPortalInsights(ctxWith(["view_reports"], "ws-A"));
    // The reused analytics must be invoked with the context's workspace id —
    // nothing else can widen the scope to another tenant.
    expect(getStatsByChannel).toHaveBeenCalledWith("ws-A", 30);
    expect(loadThemeWinners).toHaveBeenCalledWith("ws-A", 5);
  });

  it("returns the reused channels + winning themes", async () => {
    const out = await getPortalInsights(ctxWith(["view_reports", "approve"]));
    expect(out.channels).toHaveLength(1);
    expect(out.channels[0].channel).toBe("x");
    expect(out.winningThemes).toHaveLength(1);
    expect(out.winningThemes[0].tag).toBe("founder-story");
  });
});
