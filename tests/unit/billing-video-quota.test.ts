import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageSnapshot } from "@/lib/billing/usage";

// ── Unit: video quota gating (src/lib/billing/limits.ts) ─────────────────────
//
// assertWithinVideoQuota reads the workspace plan (via supabaseService) and the
// monthly usage snapshot (via @/lib/billing/usage). We mock both so we can dial
// the plan + current usage precisely. tierFor() (the real tier table) is used
// as-is, so the videosPerMonth thresholds match production.

// Mutable plan returned by the fake workspaces lookup.
const planHolder = { plan: "pro" as string | null };

vi.mock("@/lib/supabase/service", () => ({
  supabaseService: () => ({
    from(table: string) {
      if (table !== "workspaces") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: { plan: planHolder.plan }, error: null }),
          }),
        }),
      };
    },
  }),
}));

// Mutable usage snapshot.
const usageHolder: { snapshot: UsageSnapshot } = {
  snapshot: { month: "2026-05", postsGenerated: 0, imagesGenerated: 0, videosGenerated: 0 },
};
vi.mock("@/lib/billing/usage", () => ({
  getUsageSnapshot: () => Promise.resolve(usageHolder.snapshot),
}));

import { assertWithinVideoQuota, QuotaExceededError } from "@/lib/billing/limits";

function setUsage(videosGenerated: number) {
  usageHolder.snapshot = {
    month: "2026-05",
    postsGenerated: 0,
    imagesGenerated: 0,
    videosGenerated,
  };
}

beforeEach(() => {
  planHolder.plan = "pro";
  setUsage(0);
});
afterEach(() => {
  vi.clearAllMocks();
});

// Blotato-competitive ladder: pro (Solo) videosPerMonth = 250, agency = 6000.
describe("assertWithinVideoQuota: under the limit", () => {
  it("passes when usage + requested is below the tier cap (pro = 250)", async () => {
    setUsage(5);
    await expect(assertWithinVideoQuota("ws", 1)).resolves.toBeUndefined();
  });

  it("passes at exactly the boundary (usage + requested == limit)", async () => {
    setUsage(249); // 249 + 1 == 250, allowed
    await expect(assertWithinVideoQuota("ws", 1)).resolves.toBeUndefined();
  });
});

describe("assertWithinVideoQuota: at/over the limit", () => {
  it("throws QuotaExceededError when usage + requested would exceed the cap", async () => {
    setUsage(250); // 250 + 1 > 250
    await expect(assertWithinVideoQuota("ws", 1)).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it("the thrown error reports kind=videos, plan, current and limit", async () => {
    setUsage(250);
    try {
      await assertWithinVideoQuota("ws", 1);
      throw new Error("expected QuotaExceededError");
    } catch (err) {
      expect(err).toBeInstanceOf(QuotaExceededError);
      const q = err as QuotaExceededError;
      expect(q.kind).toBe("videos");
      expect(q.plan).toBe("pro");
      expect(q.current).toBe(250);
      expect(q.limit).toBe(250);
    }
  });

  it("respects a requested count > 1 (batch render)", async () => {
    setUsage(248); // 248 + 5 > 250
    await expect(assertWithinVideoQuota("ws", 5)).rejects.toBeInstanceOf(QuotaExceededError);
  });
});

describe("assertWithinVideoQuota: tier semantics", () => {
  it("treats videosPerMonth === 0 (hobby) as 'not included' and always throws", async () => {
    planHolder.plan = "hobby";
    setUsage(0); // even with zero usage, the feature is off
    await expect(assertWithinVideoQuota("ws", 1)).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it("the hobby 'not included' error reports limit 0 with kind=videos", async () => {
    planHolder.plan = "hobby";
    try {
      await assertWithinVideoQuota("ws", 1);
      throw new Error("expected QuotaExceededError");
    } catch (err) {
      const q = err as QuotaExceededError;
      expect(q).toBeInstanceOf(QuotaExceededError);
      expect(q.kind).toBe("videos");
      expect(q.limit).toBe(0);
      expect(q.message).toMatch(/not included/i);
    }
  });

  it("defaults an unknown/missing plan to hobby (feature off)", async () => {
    planHolder.plan = null; // getPlanForWorkspace falls back to 'hobby'
    await expect(assertWithinVideoQuota("ws", 1)).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it("agency tier (6000) allows a higher ceiling", async () => {
    planHolder.plan = "agency";
    setUsage(5999);
    await expect(assertWithinVideoQuota("ws", 1)).resolves.toBeUndefined();
    setUsage(6000);
    await expect(assertWithinVideoQuota("ws", 1)).rejects.toBeInstanceOf(QuotaExceededError);
  });
});
