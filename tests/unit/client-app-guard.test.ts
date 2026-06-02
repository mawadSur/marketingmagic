import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Unit: agency-app guard against clients (src/lib/workspace.ts) ─────────────
//
// blockClientsFromAgencyApp() is the gate at the top of the (app) shell. A
// CLIENT — no agency footprint (0 workspaces via owner/member, 0 org
// memberships) AND ≥1 client_membership — must be REDIRECTED to /portal and can
// never load an agency page. Agency/solo users (any workspace or org row) pass
// through untouched. A brand-new user with nothing at all is NOT redirected
// (the normal onboarding flow handles them).
//
// We drive the three head-count probes (workspaces / org_memberships /
// client_memberships) and assert exactly whether redirect("/portal") fires.

const { redirect, counts } = vi.hoisted(() => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  }),
  counts: { workspaces: 0, org_memberships: 0, client_memberships: 0 } as Record<string, number>,
}));

// A head-count query: `.from(t).select(col, { head: true, count }).` resolves to
// { count }. We thread the per-table count from the shared `counts` object.
function makeServerClient() {
  return {
    from: (table: string) => ({
      select: async () => ({ count: counts[table] ?? 0 }),
    }),
  };
}

vi.mock("@/lib/supabase/server", () => ({ supabaseServer: async () => makeServerClient() }));
vi.mock("next/navigation", () => ({ redirect }));
// next/headers is imported at module top in workspace.ts (cookies); stub it.
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => {} }) }));

import { blockClientsFromAgencyApp, isClientOnlyUser } from "@/lib/workspace";

beforeEach(() => {
  counts.workspaces = 0;
  counts.org_memberships = 0;
  counts.client_memberships = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("isClientOnlyUser", () => {
  it("true when no workspaces and no org memberships", async () => {
    expect(await isClientOnlyUser()).toBe(true);
  });

  it("false when the user owns/belongs to a workspace (agency/solo)", async () => {
    counts.workspaces = 1;
    expect(await isClientOnlyUser()).toBe(false);
  });

  it("false when the user is an org member (agency staff)", async () => {
    counts.org_memberships = 1;
    expect(await isClientOnlyUser()).toBe(false);
  });
});

describe("blockClientsFromAgencyApp", () => {
  it("REDIRECTS a client (no agency footprint + has client memberships) to /portal", async () => {
    counts.workspaces = 0;
    counts.org_memberships = 0;
    counts.client_memberships = 1;
    await expect(blockClientsFromAgencyApp()).rejects.toThrow("REDIRECT:/portal");
    expect(redirect).toHaveBeenCalledWith("/portal");
  });

  it("does NOT redirect an agency user (has a workspace) — they reach the app", async () => {
    counts.workspaces = 2;
    counts.client_memberships = 0;
    await blockClientsFromAgencyApp(); // no throw
    expect(redirect).not.toHaveBeenCalled();
  });

  it("does NOT redirect agency staff (org member) even with a stray client link", async () => {
    counts.org_memberships = 1;
    counts.client_memberships = 1;
    await blockClientsFromAgencyApp();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("does NOT redirect a brand-new user with nothing (onboarding handles them)", async () => {
    counts.workspaces = 0;
    counts.org_memberships = 0;
    counts.client_memberships = 0;
    await blockClientsFromAgencyApp();
    expect(redirect).not.toHaveBeenCalled();
  });
});
