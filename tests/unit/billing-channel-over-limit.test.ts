import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Unit: SOFT channel-cap (retroactive) over-limit computation ──────────────
//
// Covers src/lib/billing/limits.ts:
//   * selectOverLimitIds  — the PURE oldest-N-kept core (no DB). This is the
//                           single source of truth every enforcement point reuses
//                           (publish cron, poll-interactions cron, channels UI).
//   * overLimitAccountIds — the workspace resolver: effective plan (mocked) +
//                           live accounts (mocked) → over-limit id set.
//   * isAccountOverLimit  — thin single-account wrapper over the above.
//
// The COMPUTED-ON-READ design (no cached column, no migration) means upgrade
// re-activation is free: flip the effective plan to an unlimited tier and the
// next read returns an empty set. The "free re-activation" test asserts exactly
// that, with no recompute step.

// ── Mocks (only needed by the resolver/wrapper tests) ────────────────────────

// Mutable effective plan returned by the entitlement resolver. overLimitAccountIds
// reads the EFFECTIVE plan through resolvePlanForWorkspace (handles org inheritance
// + Stripe-lapse → hobby), so we dial it here.
const planHolder = { plan: "hobby" as string };
vi.mock("@/lib/billing/entitlements", () => ({
  resolvePlanForWorkspace: () => Promise.resolve(planHolder.plan),
}));

// Mutable live-account rows + an error flag to exercise the fail-OPEN path.
interface FakeRow {
  id: string;
  created_at: string;
}
const dbHolder: { rows: FakeRow[]; error: { message: string } | null } = {
  rows: [],
  error: null,
};

// Minimal supabase-service stub: only the social_accounts read overLimitAccountIds
// performs. The chained .neq/.order calls return `this` so the final await resolves
// the rows (already ordered created_at ASC, id ASC to mirror the real query).
vi.mock("@/lib/supabase/service", () => {
  const builder = {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    neq() {
      return this;
    },
    order() {
      return this;
    },
    then(resolve: (v: { data: FakeRow[] | null; error: { message: string } | null }) => void) {
      resolve({ data: dbHolder.error ? null : dbHolder.rows, error: dbHolder.error });
    },
  };
  return {
    supabaseService: () => ({
      from(table: string) {
        if (table !== "social_accounts") throw new Error(`unexpected table ${table}`);
        return builder;
      },
    }),
  };
});

import {
  selectOverLimitIds,
  overLimitAccountIds,
  isAccountOverLimit,
} from "@/lib/billing/limits";

function rows(...ids: Array<[string, string]>): FakeRow[] {
  return ids.map(([id, created_at]) => ({ id, created_at }));
}

beforeEach(() => {
  planHolder.plan = "hobby";
  dbHolder.rows = [];
  dbHolder.error = null;
});
afterEach(() => {
  vi.clearAllMocks();
});

// ── PURE core: selectOverLimitIds ────────────────────────────────────────────

describe("selectOverLimitIds: unlimited / -1", () => {
  it("returns an empty set for an unlimited plan (-1), regardless of count", () => {
    const live = rows(["a", "2026-01-01"], ["b", "2026-02-01"], ["c", "2026-03-01"]);
    expect(selectOverLimitIds(live, -1).size).toBe(0);
  });
});

describe("selectOverLimitIds: at or under the limit", () => {
  it("returns an empty set when count < limit", () => {
    const live = rows(["a", "2026-01-01"]);
    expect(selectOverLimitIds(live, 3).size).toBe(0);
  });

  it("returns an empty set EXACTLY at the limit (count === limit)", () => {
    const live = rows(["a", "2026-01-01"], ["b", "2026-02-01"], ["c", "2026-03-01"]);
    expect(selectOverLimitIds(live, 3).size).toBe(0);
  });

  it("returns an empty set for an empty workspace", () => {
    expect(selectOverLimitIds([], 1).size).toBe(0);
  });
});

describe("selectOverLimitIds: over the limit (oldest-N-kept)", () => {
  it("keeps the OLDEST account active and marks the rest over-limit (hobby, limit 1)", () => {
    // Pass them out of order to prove the function sorts by created_at.
    const live = rows(
      ["new", "2026-03-01"],
      ["old", "2026-01-01"],
      ["mid", "2026-02-01"],
    );
    const over = selectOverLimitIds(live, 1);
    expect(over.has("old")).toBe(false); // oldest is kept active
    expect(over.has("mid")).toBe(true);
    expect(over.has("new")).toBe(true);
    expect(over.size).toBe(2);
  });

  it("keeps the oldest N and marks count - N over-limit (limit 2 of 5)", () => {
    const live = rows(
      ["a", "2026-01-01"],
      ["b", "2026-02-01"],
      ["c", "2026-03-01"],
      ["d", "2026-04-01"],
      ["e", "2026-05-01"],
    );
    const over = selectOverLimitIds(live, 2);
    expect([...over].sort()).toEqual(["c", "d", "e"]);
  });

  it("a non-positive limit (defensive) marks every account over-limit", () => {
    const live = rows(["a", "2026-01-01"], ["b", "2026-02-01"]);
    expect(selectOverLimitIds(live, 0).size).toBe(2);
  });
});

describe("selectOverLimitIds: created_at tie broken by id (determinism)", () => {
  it("orders ties by id ASC — lower id is the kept-oldest, higher id is over-limit", () => {
    // Identical timestamps; only id breaks the tie. limit 1 keeps the lower id.
    const live = rows(["zzz", "2026-01-01"], ["aaa", "2026-01-01"]);
    const over = selectOverLimitIds(live, 1);
    expect(over.has("aaa")).toBe(false); // 'aaa' < 'zzz' → kept active
    expect(over.has("zzz")).toBe(true);
  });

  it("is stable: input order does not change the result on a tie", () => {
    const a = rows(["zzz", "2026-01-01"], ["aaa", "2026-01-01"]);
    const b = rows(["aaa", "2026-01-01"], ["zzz", "2026-01-01"]);
    expect([...selectOverLimitIds(a, 1)]).toEqual([...selectOverLimitIds(b, 1)]);
  });
});

// ── Resolver: overLimitAccountIds (effective plan + live accounts) ───────────

describe("overLimitAccountIds: resolves the set from the effective plan", () => {
  it("hobby (limit 1) over the cap → newest accounts over-limit", async () => {
    planHolder.plan = "hobby";
    dbHolder.rows = rows(
      ["old", "2026-01-01"],
      ["mid", "2026-02-01"],
      ["new", "2026-03-01"],
    );
    const over = await overLimitAccountIds("ws");
    expect([...over].sort()).toEqual(["mid", "new"]);
  });

  it("at exactly the hobby cap (1 account) → empty set", async () => {
    planHolder.plan = "hobby";
    dbHolder.rows = rows(["only", "2026-01-01"]);
    expect((await overLimitAccountIds("ws")).size).toBe(0);
  });

  it("fails OPEN on a DB read error (returns empty — never freezes the pipeline)", async () => {
    planHolder.plan = "hobby";
    dbHolder.rows = rows(["old", "2026-01-01"], ["new", "2026-02-01"]);
    dbHolder.error = { message: "transient db hiccup" };
    expect((await overLimitAccountIds("ws")).size).toBe(0);
  });
});

describe("overLimitAccountIds: upgrade re-activates for FREE (computed-on-read)", () => {
  it("the same accounts that were over-limit on hobby become empty on an unlimited plan, with no recompute step", async () => {
    dbHolder.rows = rows(
      ["old", "2026-01-01"],
      ["mid", "2026-02-01"],
      ["new", "2026-03-01"],
    );
    // Before upgrade: hobby (limit 1) → two accounts over-limit.
    planHolder.plan = "hobby";
    expect((await overLimitAccountIds("ws")).size).toBe(2);

    // Upgrade: effective plan flips to an unlimited tier (channels === -1).
    // No social_accounts write, no flag flip, no recompute — the next READ
    // simply sees the higher limit and returns an empty set.
    planHolder.plan = "pro"; // pro / agency / founder all have channels === -1
    expect((await overLimitAccountIds("ws")).size).toBe(0);
  });
});

// ── Wrapper: isAccountOverLimit ──────────────────────────────────────────────

describe("isAccountOverLimit: single-account convenience check", () => {
  it("true for an over-limit account, false for the kept-active oldest", async () => {
    planHolder.plan = "hobby";
    dbHolder.rows = rows(["old", "2026-01-01"], ["new", "2026-02-01"]);
    expect(await isAccountOverLimit("ws", "new")).toBe(true);
    expect(await isAccountOverLimit("ws", "old")).toBe(false);
  });

  it("false for an unknown account id", async () => {
    planHolder.plan = "hobby";
    dbHolder.rows = rows(["old", "2026-01-01"], ["new", "2026-02-01"]);
    expect(await isAccountOverLimit("ws", "ghost")).toBe(false);
  });
});
