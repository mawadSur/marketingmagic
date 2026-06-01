import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Unit: referral program (src/lib/growth/referrals.ts) ─────────────────────
//
// Focus on attributeWorkspaceCreation — the security-sensitive path that grants
// bonus quota. We mock the ref cookie (next/headers) and the service-role DB so
// we can assert:
//   * no cookie / unknown code / self-referral → NO referral row, NO reward
//   * valid foreign code → one referrals insert + a referral_bonus_posts bump
//   * a duplicate (already-attributed) insert → NO double reward
//   * the cookie is always cleared afterward (no stale re-attribution)
// Plus the cheap isValidRefParam format guard.

// ── ref cookie mock ──────────────────────────────────────────────────────────
const cookieStore = {
  value: undefined as string | undefined,
  get: (_name: string) => (cookieStore.value === undefined ? undefined : { value: cookieStore.value }),
  set: vi.fn(),
  delete: vi.fn(() => {
    cookieStore.value = undefined;
  }),
};

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve(cookieStore),
}));

// ── service-role DB mock ─────────────────────────────────────────────────────
// referral_codes lookup returns the referrer workspace for a known code.
// referrals.insert can be dialed to succeed or to return a duplicate error.
// workspaces select/update tracks the bonus grant.
const db = {
  knownCode: "abcd1234", // resolves to referrerWs
  referrerWs: "referrer-ws-id",
  insertReferral: vi.fn((_row?: unknown) => Promise.resolve({ error: null as { message: string } | null })),
  workspaceBonus: 0,
  updateWorkspace: vi.fn((patch: { referral_bonus_posts?: number }) => {
    if (typeof patch.referral_bonus_posts === "number") db.workspaceBonus = patch.referral_bonus_posts;
    return Promise.resolve({ error: null });
  }),
};

vi.mock("@/lib/supabase/service", () => ({
  supabaseService: () => ({
    from(table: string) {
      if (table === "referral_codes") {
        return {
          select: () => ({
            ilike: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: { workspace_id: db.referrerWs },
                  error: null,
                }),
            }),
          }),
        };
      }
      if (table === "referrals") {
        return { insert: (row: unknown) => db.insertReferral(row) };
      }
      // workspaces
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: { referral_bonus_posts: db.workspaceBonus }, error: null }),
          }),
        }),
        update: (patch: { referral_bonus_posts?: number }) => ({
          eq: () => db.updateWorkspace(patch),
        }),
      };
    },
  }),
}));

import { attributeWorkspaceCreation, isValidRefParam, REFERRAL_BONUS_POSTS } from "@/lib/growth/referrals";

beforeEach(() => {
  cookieStore.value = undefined;
  cookieStore.set.mockClear();
  cookieStore.delete.mockClear();
  db.insertReferral.mockClear();
  db.insertReferral.mockImplementation(() => Promise.resolve({ error: null }));
  db.updateWorkspace.mockClear();
  db.workspaceBonus = 0;
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("isValidRefParam", () => {
  it("accepts 6–16 alphanumerics", () => {
    expect(isValidRefParam("abcd12")).toBe(true);
    expect(isValidRefParam("ABCDefgh12345678")).toBe(true);
  });
  it("rejects malformed / out-of-range values", () => {
    expect(isValidRefParam("short")).toBe(false); // < 6
    expect(isValidRefParam("with space")).toBe(false);
    expect(isValidRefParam("toolongtoolongtoolong")).toBe(false); // > 16
    expect(isValidRefParam(null)).toBe(false);
    expect(isValidRefParam(undefined)).toBe(false);
  });
});

describe("attributeWorkspaceCreation", () => {
  it("no pending cookie → no referral, no reward", async () => {
    await attributeWorkspaceCreation("new-ws");
    expect(db.insertReferral).not.toHaveBeenCalled();
    expect(db.updateWorkspace).not.toHaveBeenCalled();
  });

  it("valid foreign code → inserts referral and grants the bonus", async () => {
    cookieStore.value = db.knownCode;
    await attributeWorkspaceCreation("new-ws");
    expect(db.insertReferral).toHaveBeenCalledTimes(1);
    expect(db.updateWorkspace).toHaveBeenCalledTimes(1);
    expect(db.workspaceBonus).toBe(REFERRAL_BONUS_POSTS);
    expect(cookieStore.delete).toHaveBeenCalled(); // cookie always cleared
  });

  it("self-referral (code resolves to the same workspace) → no-op", async () => {
    cookieStore.value = db.knownCode;
    await attributeWorkspaceCreation(db.referrerWs); // same ws as the code owner
    expect(db.insertReferral).not.toHaveBeenCalled();
    expect(db.updateWorkspace).not.toHaveBeenCalled();
    expect(cookieStore.delete).toHaveBeenCalled();
  });

  it("duplicate insert (already attributed) → no double reward", async () => {
    cookieStore.value = db.knownCode;
    db.insertReferral.mockImplementation(() =>
      Promise.resolve({ error: { message: "duplicate key value violates unique constraint" } }),
    );
    await attributeWorkspaceCreation("new-ws");
    expect(db.insertReferral).toHaveBeenCalledTimes(1);
    expect(db.updateWorkspace).not.toHaveBeenCalled(); // reward skipped
    expect(cookieStore.delete).toHaveBeenCalled();
  });

  it("malformed cookie value → ignored, no DB writes", async () => {
    cookieStore.value = "bad value!";
    await attributeWorkspaceCreation("new-ws");
    expect(db.insertReferral).not.toHaveBeenCalled();
    expect(db.updateWorkspace).not.toHaveBeenCalled();
  });
});
