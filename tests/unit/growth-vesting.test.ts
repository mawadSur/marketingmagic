import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Unit: referral reward vesting (src/lib/growth/referrals.ts) ──────────────
//
// vestReferralOnFirstPost is the anti-farming choke point: the +5 referral
// bonus is granted ONLY when the referred workspace ships its first post, and
// NEVER twice. We model the service-role DB so we can assert:
//   * not-the-first-post (>1 posted row) → no vest attempt, no grant
//   * first post + an unvested referral → vested_at flips, referrer +5'd ONCE
//   * a SECOND call (already vested) → conditional update matches 0 rows → no
//     second grant (idempotency: the null→now() flip is the single-grant key)
//   * first post but workspace wasn't referred → no grant
//
// The conditional flip is modelled by a one-shot `vestedAlready` latch: the
// first .is("vested_at", null) update returns the referrer row and sets the
// latch; subsequent ones return null (no row), exactly like a real
// `UPDATE ... WHERE vested_at IS NULL RETURNING ...`.

interface VestState {
  postedCount: number;
  hasUnvestedReferral: boolean;
  referrerWs: string;
  vestedAlready: boolean;
  referrerBonus: number;
}

const state: VestState = {
  postedCount: 1,
  hasUnvestedReferral: true,
  referrerWs: "referrer-ws",
  vestedAlready: false,
  referrerBonus: 0,
};

const grantSpy = vi.fn();

vi.mock("@/lib/supabase/service", () => {
  // Minimal chainable builder covering exactly the calls vestReferralOnFirstPost
  // / grantReferralBonus make against each table.
  function client() {
    return {
      from(table: string) {
        if (table === "posts") {
          // .select(..., {count, head}).eq().eq() → resolves to { count }
          const chain = {
            select: () => chain,
            eq: () => chain,
            then: (resolve: (v: { count: number }) => unknown) =>
              resolve({ count: state.postedCount }),
          };
          return chain;
        }
        if (table === "referrals") {
          // .update().eq().is("vested_at", null).select().maybeSingle()
          return {
            update: () => ({
              eq: () => ({
                is: () => ({
                  select: () => ({
                    maybeSingle: () => {
                      if (!state.hasUnvestedReferral || state.vestedAlready) {
                        return Promise.resolve({ data: null, error: null });
                      }
                      state.vestedAlready = true; // one-shot flip
                      return Promise.resolve({
                        data: { referrer_workspace_id: state.referrerWs },
                        error: null,
                      });
                    },
                  }),
                }),
              }),
            }),
          };
        }
        // workspaces — read current bonus, then write the bumped value.
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: { referral_bonus_posts: state.referrerBonus }, error: null }),
            }),
          }),
          update: (patch: { referral_bonus_posts?: number }) => ({
            eq: () => {
              if (typeof patch.referral_bonus_posts === "number") {
                state.referrerBonus = patch.referral_bonus_posts;
                grantSpy(patch.referral_bonus_posts);
              }
              return Promise.resolve({ error: null });
            },
          }),
        };
      },
    };
  }
  return { supabaseService: () => client() };
});

import { vestReferralOnFirstPost, REFERRAL_BONUS_POSTS } from "@/lib/growth/referrals";
import { supabaseService } from "@/lib/supabase/service";

beforeEach(() => {
  state.postedCount = 1;
  state.hasUnvestedReferral = true;
  state.referrerWs = "referrer-ws";
  state.vestedAlready = false;
  state.referrerBonus = 0;
  grantSpy.mockClear();
});
afterEach(() => vi.clearAllMocks());

describe("vestReferralOnFirstPost", () => {
  it("not the first post (workspace already shipped) → no grant", async () => {
    state.postedCount = 3;
    await vestReferralOnFirstPost(supabaseService(), "referred-ws");
    expect(grantSpy).not.toHaveBeenCalled();
    expect(state.referrerBonus).toBe(0);
    expect(state.vestedAlready).toBe(false); // never even attempted the flip
  });

  it("first post + unvested referral → vests and grants +5 exactly once", async () => {
    await vestReferralOnFirstPost(supabaseService(), "referred-ws");
    expect(grantSpy).toHaveBeenCalledTimes(1);
    expect(state.referrerBonus).toBe(REFERRAL_BONUS_POSTS);
    expect(state.vestedAlready).toBe(true);
  });

  it("idempotent: a second call after vesting does NOT double-grant", async () => {
    // First call vests + grants.
    await vestReferralOnFirstPost(supabaseService(), "referred-ws");
    // Simulate a concurrent / retried finaliser: postedCount stays 1 (still the
    // only posted row from this tick's perspective), but the conditional flip
    // now matches zero rows because vested_at is already set.
    await vestReferralOnFirstPost(supabaseService(), "referred-ws");
    expect(grantSpy).toHaveBeenCalledTimes(1); // never granted twice
    expect(state.referrerBonus).toBe(REFERRAL_BONUS_POSTS);
  });

  it("first post but workspace wasn't referred → no grant", async () => {
    state.hasUnvestedReferral = false;
    await vestReferralOnFirstPost(supabaseService(), "referred-ws");
    expect(grantSpy).not.toHaveBeenCalled();
    expect(state.referrerBonus).toBe(0);
  });
});
