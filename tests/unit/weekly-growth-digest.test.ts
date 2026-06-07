import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Unit: weekly growth digest composer + renderer (Bet 5) ──────────────────
//
// assembleWeeklyDigest chains Bet 1 (revenue-by-theme + winners), the
// posts-shipped roll-up, and a Bet 4 community-activity SUMMARY (logs, read-
// only) into one weekly digest payload, then recommends a focus. It must:
//   1. Sum posts shipped + reach/engagement from the latest metric per post.
//   2. Surface revenue-by-theme from computeThemeOutcomes (Bet 1).
//   3. Summarise auto_reply_log + dm_capture_log WITHOUT sending anything.
//   4. Recommend focus deterministically — revenue-driving themes first, then
//      confident engagement winners.
//   5. COLD START: zero activity everywhere → null (the cron skips the send).
//   6. Bound AI to ONE call; on failure / no key → a deterministic narrative.
// The window helper + renderer (HTML-escaping, draft-vs-auto copy) are covered
// at the bottom — the renderer is the injection boundary for this surface.

// ── Mocks ────────────────────────────────────────────────────────────────
const computeThemeOutcomes = vi.fn();
const loadThemeWinners = vi.fn();
vi.mock("@/lib/analytics/outcomes", async () => {
  const actual = await vi.importActual<typeof import("@/lib/analytics/outcomes")>(
    "@/lib/analytics/outcomes",
  );
  return {
    ...actual, // keep the real formatCents / UNTAGGED_THEME
    computeThemeOutcomes: (...a: unknown[]) => computeThemeOutcomes(...a),
  };
});
vi.mock("@/lib/analytics/themes", () => ({
  loadThemeWinners: (...a: unknown[]) => loadThemeWinners(...a),
}));

// Chainable Supabase stub. posts: .select.eq.eq.gte.limit; post_metrics:
// .select.in.order; auto_reply_log/dm_capture_log: .select.eq.gte.limit. Every
// builder is awaitable (thenable) and resolves to the per-table fixture.
interface Fixture {
  posts: { data: unknown[] | null; error: unknown };
  post_metrics: { data: unknown[] | null; error: unknown };
  auto_reply_log: { data: unknown[] | null; error: unknown };
  dm_capture_log: { data: unknown[] | null; error: unknown };
}
let fixture: Fixture;

function makeBuilder(table: keyof Fixture) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  for (const m of ["select", "eq", "gte", "lt", "in", "order", "limit", "not", "maybeSingle"]) {
    builder[m] = vi.fn(chain);
  }
  builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(fixture[table]).then(resolve, reject);
  return builder;
}
vi.mock("@/lib/supabase/service", () => ({
  supabaseService: () => ({ from: (t: string) => makeBuilder(t as keyof Fixture) }),
}));

// env: control whether a Claude key is present (drives narrative vs fallback).
let env = { ANTHROPIC_API_KEY: "" as string };
vi.mock("@/lib/env", () => ({ serverEnv: () => env, siteUrl: () => "https://app.test" }));

// Anthropic SDK stub — capture how many times the single narrative call fires.
const streamFinal = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { stream: () => ({ finalMessage: () => streamFinal() }) };
  },
}));

import {
  assembleWeeklyDigest,
  cycleWindowStart,
  deterministicNarrative,
  generateWeeklyNarrative,
  type AssembleOpts,
} from "@/lib/growth/weekly-digest";
import { renderWeeklyGrowthDigest } from "@/lib/growth/weekly-digest-html";

const NOW = new Date("2026-06-06T12:00:00Z"); // Saturday → window Mon Jun 1
const baseOpts: AssembleOpts = {
  workspaceName: "Acme Co",
  mode: "draft",
  dashboardUrl: "https://app.test/dashboard",
  analyticsUrl: "https://app.test/analytics",
  now: NOW,
};

beforeEach(() => {
  env = { ANTHROPIC_API_KEY: "" };
  fixture = {
    posts: { data: [], error: null },
    post_metrics: { data: [], error: null },
    auto_reply_log: { data: [], error: null },
    dm_capture_log: { data: [], error: null },
  };
  computeThemeOutcomes.mockResolvedValue({
    hasOutcomes: false,
    themes: [],
    totalOutcomes: 0,
    totalRevenueCents: 0,
  });
  loadThemeWinners.mockResolvedValue([]);
  streamFinal.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe("cycleWindowStart", () => {
  it("snaps any day of the week back to that week's Monday (UTC)", () => {
    expect(cycleWindowStart(new Date("2026-06-06T12:00:00Z"))).toBe("2026-06-01"); // Sat
    expect(cycleWindowStart(new Date("2026-06-01T00:00:00Z"))).toBe("2026-06-01"); // Mon itself
    expect(cycleWindowStart(new Date("2026-06-07T23:59:00Z"))).toBe("2026-06-01"); // Sun
    expect(cycleWindowStart(new Date("2026-06-08T00:00:00Z"))).toBe("2026-06-08"); // next Mon
  });
});

describe("assembleWeeklyDigest — aggregation & chaining", () => {
  it("sums posts shipped + latest metric per post and surfaces revenue-by-theme", async () => {
    fixture.posts.data = [
      { id: "p1", channel: "x" },
      { id: "p2", channel: "linkedin" },
    ];
    fixture.post_metrics.data = [
      { post_id: "p1", fetched_at: "2026-06-04T00:00:00Z", impressions: 200, likes: 10, reposts: 2, replies: 1 },
      { post_id: "p1", fetched_at: "2026-06-03T00:00:00Z", impressions: 100, likes: 5, reposts: 1, replies: 0 },
      { post_id: "p2", fetched_at: "2026-06-04T00:00:00Z", impressions: 300, likes: 20, reposts: 5, replies: 3 },
    ];
    computeThemeOutcomes.mockResolvedValue({
      hasOutcomes: true,
      totalOutcomes: 3,
      totalRevenueCents: 51500,
      themes: [
        { tag: "founder-story", outcomes: 2, revenue_cents: 50000, outcomes_with_value: 2, by_type: {} },
        { tag: "how-to", outcomes: 1, revenue_cents: 1500, outcomes_with_value: 1, by_type: {} },
      ],
    });

    const d = await assembleWeeklyDigest("ws-A", baseOpts);
    expect(d).not.toBeNull();
    expect(d!.shipped.posts).toBe(2);
    expect(d!.shipped.impressions).toBe(500); // 200 (newest p1) + 300 (p2)
    expect(d!.shipped.engagements).toBe(41); // (10+2+1) + (20+5+3)
    expect(d!.revenueCents).toBe(51500);
    expect(d!.themeRevenue[0].tag).toBe("founder-story");
    expect(d!.windowStart).toBe("2026-06-01");
  });

  it("summarises Bet 4 community logs WITHOUT sending (counts sent/blocked/leads)", async () => {
    fixture.posts.data = [{ id: "p1", channel: "x" }];
    fixture.post_metrics.data = [
      { post_id: "p1", fetched_at: "2026-06-04T00:00:00Z", impressions: 10, likes: 1, reposts: 0, replies: 0 },
    ];
    fixture.auto_reply_log.data = [
      { outcome: "sent" },
      { outcome: "sent" },
      { outcome: "blocked" },
      { outcome: "failed" },
    ];
    fixture.dm_capture_log.data = [
      { outcome: "sent", lead_tagged: true },
      { outcome: "sent", lead_tagged: false },
      { outcome: "scope_missing", lead_tagged: false }, // clean no-op — not counted as blocked
      { outcome: "blocked", lead_tagged: false },
    ];

    const d = await assembleWeeklyDigest("ws-A", baseOpts);
    expect(d!.community.autoRepliesSent).toBe(2);
    expect(d!.community.dmsSent).toBe(2);
    expect(d!.community.leadsTagged).toBe(1);
    expect(d!.community.blockedOrFailed).toBe(3); // 2 reply guards + 1 dm guard (scope_missing excluded)
  });

  it("recommends revenue-driving themes first, then confident winners", async () => {
    fixture.posts.data = [{ id: "p1", channel: "x" }];
    fixture.post_metrics.data = [
      { post_id: "p1", fetched_at: "2026-06-04T00:00:00Z", impressions: 10, likes: 1, reposts: 0, replies: 0 },
    ];
    computeThemeOutcomes.mockResolvedValue({
      hasOutcomes: true,
      totalOutcomes: 2,
      totalRevenueCents: 60000,
      themes: [
        { tag: "pricing", outcomes: 1, revenue_cents: 60000, outcomes_with_value: 1, by_type: {} },
        { tag: "no-revenue-theme", outcomes: 1, revenue_cents: 0, outcomes_with_value: 0, by_type: {} },
      ],
    });
    loadThemeWinners.mockResolvedValue([
      { tag: "behind-the-scenes", posterior_mean: 0.08, ci_low: 0.06, ci_high: 0.1, posts: 5, lift: 1.7 },
    ]);

    const d = await assembleWeeklyDigest("ws-A", baseOpts);
    // Revenue theme leads; the confident winner fills next; the $0 theme is not preferred.
    expect(d!.recommendedThemes[0]).toBe("pricing");
    expect(d!.recommendedThemes).toContain("behind-the-scenes");
  });

  it("COLD START: zero activity everywhere → null (cron skips the send)", async () => {
    // all fixtures empty; no outcomes; no winners (defaults from beforeEach)
    const d = await assembleWeeklyDigest("ws-cold", baseOpts);
    expect(d).toBeNull();
  });

  it("degrades gracefully when one upstream signal throws", async () => {
    fixture.posts.data = [{ id: "p1", channel: "x" }];
    fixture.post_metrics.data = [
      { post_id: "p1", fetched_at: "2026-06-04T00:00:00Z", impressions: 50, likes: 2, reposts: 0, replies: 0 },
    ];
    computeThemeOutcomes.mockRejectedValue(new Error("themes db down"));

    const d = await assembleWeeklyDigest("ws-A", baseOpts);
    expect(d).not.toBeNull(); // posts shipped is enough to not be cold-start
    expect(d!.shipped.posts).toBe(1);
    expect(d!.revenueCents).toBe(0); // outcomes degraded to empty
  });
});

describe("generateWeeklyNarrative — single bounded AI call (429 posture)", () => {
  const sample = {
    workspaceName: "Acme Co",
    windowStart: "2026-06-01",
    dateLabel: "Mon, Jun 1 – Sun, Jun 7",
    mode: "draft" as const,
    shipped: { posts: 4, impressions: 1200, engagements: 90 },
    revenueCents: 50000,
    themeRevenue: [{ tag: "pricing", revenueCents: 50000, outcomes: 2 }],
    winners: [],
    community: { autoRepliesSent: 3, dmsSent: 1, leadsTagged: 1, blockedOrFailed: 0 },
    recommendedThemes: ["pricing"],
    dashboardUrl: "https://app.test/dashboard",
    analyticsUrl: "https://app.test/analytics",
  };

  it("with NO key → deterministic fallback, zero model calls", async () => {
    env.ANTHROPIC_API_KEY = "";
    const text = await generateWeeklyNarrative(sample);
    expect(streamFinal).not.toHaveBeenCalled();
    expect(text).toContain("4 posts");
    expect(text).toMatch(/\$500/); // formatted revenue
    expect(text).toMatch(/pricing/);
  });

  it("with a key → exactly ONE streamed call, uses the model text", async () => {
    env.ANTHROPIC_API_KEY = "sk-test";
    streamFinal.mockResolvedValue({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Strong week — pricing drove the revenue." }],
    });
    const text = await generateWeeklyNarrative(sample);
    expect(streamFinal).toHaveBeenCalledTimes(1); // bounded to one call
    expect(text).toBe("Strong week — pricing drove the revenue.");
  });

  it("model failure → deterministic fallback (never throws)", async () => {
    env.ANTHROPIC_API_KEY = "sk-test";
    streamFinal.mockRejectedValue(new Error("429 rate limited"));
    const text = await generateWeeklyNarrative(sample);
    expect(text).toContain("4 posts"); // fell back, didn't throw
  });

  it("max_tokens truncation → deterministic fallback (no cut-off line)", async () => {
    env.ANTHROPIC_API_KEY = "sk-test";
    streamFinal.mockResolvedValue({
      stop_reason: "max_tokens",
      content: [{ type: "text", text: "This week you shipped 4 posts and then it cut off mid-" }],
    });
    const text = await generateWeeklyNarrative(sample);
    expect(text).toContain("Recommended focus next week"); // the deterministic shape
  });

  it("deterministicNarrative is always non-empty and mentions the focus", () => {
    const text = deterministicNarrative(sample);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toMatch(/pricing/);
  });
});

describe("renderWeeklyGrowthDigest — HTML", () => {
  const base = {
    workspaceName: "Acme Co",
    windowStart: "2026-06-01",
    dateLabel: "Mon, Jun 1 – Sun, Jun 7",
    mode: "draft" as const,
    shipped: { posts: 4, impressions: 1200, engagements: 90 },
    revenueCents: 50000,
    themeRevenue: [{ tag: "pricing", revenueCents: 50000, outcomes: 2 }],
    winners: [],
    community: { autoRepliesSent: 3, dmsSent: 1, leadsTagged: 1, blockedOrFailed: 2 },
    recommendedThemes: ["pricing"],
    narrative: "Strong week.",
    dashboardUrl: "https://app.test/dashboard",
    analyticsUrl: "https://app.test/analytics",
  };

  it("renders headline stats, revenue-by-theme, community, and the focus", () => {
    const html = renderWeeklyGrowthDigest(base);
    expect(html).toContain("Posts shipped");
    expect(html).toContain("Weekly growth recap");
    expect(html).toContain("pricing");
    expect(html).toContain("$500"); // formatCents drops cents for whole dollars
    expect(html).toContain("3 auto-replies");
    expect(html).toMatch(/2 attempt.*held back/);
    expect(html).toMatch(/Lean into .*pricing.* next week/);
  });

  it("DRAFT mode says nothing was acted on; AUTO mode acknowledges autonomy", () => {
    const draft = renderWeeklyGrowthDigest(base);
    expect(draft).toContain("Draft mode");
    expect(draft).toMatch(/Nothing was published, replanned, or sent on your behalf/);

    const auto = renderWeeklyGrowthDigest({ ...base, mode: "auto" });
    expect(auto).toContain("Autopilot");
    expect(auto).toMatch(/Autopilot is ON/);
  });

  it("HTML-escapes theme tags + narrative (injection defense)", () => {
    const html = renderWeeklyGrowthDigest({
      ...base,
      themeRevenue: [{ tag: "<script>alert(1)</script>", revenueCents: 100, outcomes: 1 }],
      recommendedThemes: ["<img src=x onerror=alert(2)>"],
      narrative: "<b>xss</b>",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<img src=x onerror=alert(2)>");
    expect(html).not.toContain("<b>xss</b>");
  });
});
