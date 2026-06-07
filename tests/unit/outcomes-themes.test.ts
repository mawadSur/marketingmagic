import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Unit: revenue-ranked theme analytics (src/lib/analytics/outcomes.ts) ──
//
// The keystone of the Outcome Loop (Bet 1). computeThemeOutcomes joins
// post_outcomes → the post's theme and rolls up per theme:
//   • outcome count + per-type breakdown,
//   • SUM(value_cents) as revenue (value-less outcomes count but add $0),
// sorted revenue desc then outcome-count desc. The COLD START path (zero
// outcomes) MUST return hasOutcomes:false so the page renders the explicit
// empty state, never an empty table.
//
// We stub supabaseService so the from(...).select(...).eq(...).limit(...)
// chain resolves to a fixed { data } — no real DB. The chain is a thin
// thenable builder: every method returns the same object, and awaiting it
// yields the seeded result.

let nextResult: { data: unknown; error: unknown } = { data: [], error: null };

function makeChain() {
  const chain: Record<string, unknown> = {};
  const passthrough = () => chain;
  chain.select = passthrough;
  chain.eq = passthrough;
  chain.limit = () => Promise.resolve(nextResult);
  return chain;
}

vi.mock("@/lib/supabase/service", () => ({
  supabaseService: () => ({ from: () => makeChain() }),
}));

import {
  computeThemeOutcomes,
  formatCents,
  UNTAGGED_THEME,
} from "@/lib/analytics/outcomes";

function row(theme: string | null, outcome_type: string, value_cents: number | null) {
  return { outcome_type, value_cents, posts: theme === null ? null : { theme } };
}

beforeEach(() => {
  nextResult = { data: [], error: null };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("computeThemeOutcomes — cold start", () => {
  it("returns hasOutcomes:false with no rows (drives the empty state)", async () => {
    nextResult = { data: [], error: null };
    const report = await computeThemeOutcomes("ws-cold");
    expect(report.hasOutcomes).toBe(false);
    expect(report.themes).toHaveLength(0);
    expect(report.totalOutcomes).toBe(0);
    expect(report.totalRevenueCents).toBe(0);
  });

  it("returns hasOutcomes:false when the query errors (degrades, never throws)", async () => {
    nextResult = { data: null, error: { message: "db down" } };
    const report = await computeThemeOutcomes("ws-err");
    expect(report.hasOutcomes).toBe(false);
    expect(report.themes).toHaveLength(0);
  });
});

describe("computeThemeOutcomes — roll-up + ranking", () => {
  it("sums value_cents per theme and ranks by revenue", async () => {
    nextResult = {
      data: [
        // founder-story: 1 sale @ $200, 1 lead (no value) → $200, 2 outcomes
        row("founder-story", "sale", 20000),
        row("founder-story", "lead", null),
        // how-to: 1 booking @ $500 → $500, 1 outcome → ranks ABOVE founder-story
        row("how-to", "booking", 50000),
      ],
      error: null,
    };

    const report = await computeThemeOutcomes("ws-1");
    expect(report.hasOutcomes).toBe(true);
    expect(report.totalOutcomes).toBe(3);
    expect(report.totalRevenueCents).toBe(70000);

    // Revenue-ranked: how-to ($500) before founder-story ($200).
    expect(report.themes.map((t) => t.tag)).toEqual(["how-to", "founder-story"]);

    const founder = report.themes.find((t) => t.tag === "founder-story")!;
    expect(founder.outcomes).toBe(2);
    expect(founder.revenue_cents).toBe(20000);
    // Only the sale carried a dollar value.
    expect(founder.outcomes_with_value).toBe(1);
    expect(founder.by_type.sale).toBe(1);
    expect(founder.by_type.lead).toBe(1);
    expect(founder.by_type.booking).toBe(0);
  });

  it("buckets outcomes on themeless posts under the Untagged sentinel", async () => {
    nextResult = {
      data: [row(null, "signup", null), row(null, "sale", 1000)],
      error: null,
    };
    const report = await computeThemeOutcomes("ws-2");
    expect(report.themes).toHaveLength(1);
    expect(report.themes[0]!.tag).toBe(UNTAGGED_THEME);
    expect(report.themes[0]!.outcomes).toBe(2);
    expect(report.themes[0]!.revenue_cents).toBe(1000);
  });

  it("breaks ties on revenue by outcome count (more outcomes ranks higher)", async () => {
    nextResult = {
      data: [
        // both themes have $0 revenue; 'busy' has more outcomes → ranks first
        row("busy", "lead", null),
        row("busy", "lead", null),
        row("quiet", "lead", null),
      ],
      error: null,
    };
    const report = await computeThemeOutcomes("ws-3");
    expect(report.themes.map((t) => t.tag)).toEqual(["busy", "quiet"]);
  });
});

describe("formatCents", () => {
  it("drops cents on whole-dollar amounts and keeps them otherwise", () => {
    expect(formatCents(0)).toBe("$0");
    expect(formatCents(120000)).toBe("$1,200");
    expect(formatCents(4999)).toBe("$49.99");
  });
});
