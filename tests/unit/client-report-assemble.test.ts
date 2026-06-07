import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Unit: monthly client report assembly + renderer (Agency Proof Engine ③) ──
//
// assembleMonthlyReport is the substance of the branded monthly proof-of-work
// report a cron emails per client workspace. It must:
//   1. Window on the PREVIOUS calendar month (testable from a fixed `now`).
//   2. Aggregate posts shipped + reach/impressions + engagement from the latest
//      metric per post.
//   3. Reuse the existing dashboard + theme analytics (so figures never diverge),
//      passing ONLY the workspaceId.
//   4. DEFENSIVELY read the sibling-owned post_outcomes table: missing table /
//      error → { enabled:false } fallback; present rows → a $ rollup.
//   5. COLD START: zero posts + zero outcomes → quietMonth:true (graceful).
//
// We mock the reused analytics + a chainable Supabase service so the test never
// touches a real DB. The renderer is exercised separately for HTML-escaping +
// the quiet-month + outcomes states (the injection boundary for this surface).

// ── Mocks ────────────────────────────────────────────────────────────────
const getStatsByChannel = vi.fn();
const loadThemeWinners = vi.fn();

vi.mock("@/lib/dashboard/analytics", () => ({
  getStatsByChannel: (...args: unknown[]) => getStatsByChannel(...args),
}));
vi.mock("@/lib/analytics/themes", () => ({
  loadThemeWinners: (...args: unknown[]) => loadThemeWinners(...args),
}));

// Chainable query-builder mock. Each `from(table)` returns a thenable builder
// whose terminal resolves to the per-table fixture. posts: .select.eq.eq.gte.lt
// .order.limit; post_metrics: .select.in.order; post_outcomes: .select.eq.gte.lt.
interface Fixture {
  posts: { data: unknown[] | null; error: unknown };
  post_metrics: { data: unknown[] | null; error: unknown };
  post_outcomes: { data: unknown[] | null; error: unknown } | "throw";
}

let fixture: Fixture;

function makeBuilder(table: keyof Fixture) {
  // The terminal value for this table.
  const settle = () => {
    const f = fixture[table];
    if (f === "throw") throw new Error("relation \"post_outcomes\" does not exist");
    return Promise.resolve(f);
  };
  // A proxy whose every method returns itself, and which is awaitable (thenable)
  // so `await svc.from(t).select(...)...whatever()` resolves to the fixture.
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  for (const m of ["select", "eq", "gte", "lt", "in", "order", "limit", "not", "maybeSingle"]) {
    builder[m] = vi.fn(chain);
  }
  builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    settle().then(resolve, reject);
  return builder;
}

vi.mock("@/lib/supabase/service", () => ({
  supabaseService: () => ({
    from: (table: string) => makeBuilder(table as keyof Fixture),
  }),
}));

import { assembleMonthlyReport, previousCalendarMonth } from "@/lib/client-report/assemble";
import { renderMonthlyReportHtml } from "@/lib/client-report/report-html";
import type { ResolvedTheme } from "@/lib/portal/branding";

const NOW = new Date("2026-06-06T12:00:00Z"); // → reports May 2026

beforeEach(() => {
  getStatsByChannel.mockResolvedValue([
    { channel: "x", posts: 2, impressions: 1000, engagement: 50, engagement_rate: 0.05 },
  ]);
  loadThemeWinners.mockResolvedValue([
    { tag: "founder-story", posterior_mean: 0.08, ci_low: 0.06, ci_high: 0.1, posts: 4, lift: 1.6 },
  ]);
  fixture = {
    posts: { data: [], error: null },
    post_metrics: { data: [], error: null },
    post_outcomes: { data: [], error: null },
  };
});

afterEach(() => vi.clearAllMocks());

describe("previousCalendarMonth", () => {
  it("returns the full prior calendar month (UTC) from any day", () => {
    const w = previousCalendarMonth(NOW);
    expect(w.start.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(w.label).toBe("May 2026");
    expect(w.days).toBe(31);
  });

  it("handles a January now → previous December of last year", () => {
    const w = previousCalendarMonth(new Date("2026-01-15T00:00:00Z"));
    expect(w.start.toISOString()).toBe("2025-12-01T00:00:00.000Z");
    expect(w.label).toBe("December 2025");
  });
});

describe("assembleMonthlyReport — aggregation", () => {
  it("aggregates posts + latest metric per post and reuses scoped analytics", async () => {
    fixture.posts.data = [
      { id: "p1", text: "Hello", channel: "x", posted_at: "2026-05-10T00:00:00Z" },
      { id: "p2", text: "World", channel: "facebook", posted_at: "2026-05-12T00:00:00Z" },
    ];
    // Two metric rows for p1 (newest first wins) + one for p2.
    fixture.post_metrics.data = [
      { post_id: "p1", fetched_at: "2026-05-11T00:00:00Z", impressions: 200, likes: 10, reposts: 2, replies: 1, clicks: 0, engagement_rate: 0.065 },
      { post_id: "p1", fetched_at: "2026-05-10T12:00:00Z", impressions: 100, likes: 5, reposts: 1, replies: 0, clicks: 0, engagement_rate: 0.06 },
      { post_id: "p2", fetched_at: "2026-05-13T00:00:00Z", impressions: 300, likes: 20, reposts: 5, replies: 3, clicks: 2, engagement_rate: 0.1 },
    ];

    const report = await assembleMonthlyReport("ws-A", NOW);

    expect(report.totals.posts).toBe(2);
    expect(report.totals.impressions).toBe(500); // 200 (newest p1) + 300 (p2)
    expect(report.totals.engagements).toBe(43); // (10+2+1) + (20+5+3+2)
    expect(report.quietMonth).toBe(false);

    // Reused analytics get ONLY the workspace id (cross-workspace isolation).
    expect(getStatsByChannel).toHaveBeenCalledWith("ws-A", 31);
    expect(loadThemeWinners).toHaveBeenCalledWith("ws-A", 5);
    expect(report.channels).toHaveLength(1);
    expect(report.winningThemes[0].tag).toBe("founder-story");
  });
});

describe("assembleMonthlyReport — outcome/$ dependency guard", () => {
  it("falls back to enabled:false when the post_outcomes table is missing", async () => {
    fixture.post_outcomes = "throw"; // simulate relation-does-not-exist
    fixture.posts.data = [{ id: "p1", text: "Hi", channel: "x", posted_at: "2026-05-10T00:00:00Z" }];
    fixture.post_metrics.data = [
      { post_id: "p1", fetched_at: "2026-05-11T00:00:00Z", impressions: 10, likes: 1, reposts: 0, replies: 0, clicks: 0, engagement_rate: 0.1 },
    ];

    const report = await assembleMonthlyReport("ws-A", NOW);
    expect(report.outcomes.enabled).toBe(false);
    expect(report.outcomes.totalValueCents).toBe(0);
  });

  it("falls back to enabled:false on a query error (RLS / permission)", async () => {
    fixture.post_outcomes = { data: null, error: { message: "permission denied" } };
    const report = await assembleMonthlyReport("ws-A", NOW);
    expect(report.outcomes.enabled).toBe(false);
  });

  it("rolls up value_cents when outcomes are present", async () => {
    fixture.posts.data = [{ id: "p1", text: "Hi", channel: "x", posted_at: "2026-05-10T00:00:00Z" }];
    fixture.post_metrics.data = [
      { post_id: "p1", fetched_at: "2026-05-11T00:00:00Z", impressions: 10, likes: 1, reposts: 0, replies: 0, clicks: 0, engagement_rate: 0.1 },
    ];
    fixture.post_outcomes = {
      data: [
        { outcome_type: "sale", value_cents: 50000, note: "Enterprise deal" },
        { outcome_type: "lead", value_cents: 1500, note: null },
      ],
      error: null,
    };

    const report = await assembleMonthlyReport("ws-A", NOW);
    expect(report.outcomes.enabled).toBe(true);
    expect(report.outcomes.count).toBe(2);
    expect(report.outcomes.totalValueCents).toBe(51500);
    // Most valuable first.
    expect(report.outcomes.items[0].outcomeType).toBe("sale");
  });

  it("enabled:true with empty rollup when the table exists but has no rows", async () => {
    fixture.post_outcomes = { data: [], error: null };
    fixture.posts.data = [{ id: "p1", text: "Hi", channel: "x", posted_at: "2026-05-10T00:00:00Z" }];
    fixture.post_metrics.data = [];
    const report = await assembleMonthlyReport("ws-A", NOW);
    expect(report.outcomes.enabled).toBe(true);
    expect(report.outcomes.count).toBe(0);
  });
});

describe("assembleMonthlyReport — cold start", () => {
  it("zero posts + zero outcomes → graceful quietMonth report", async () => {
    fixture.posts.data = [];
    fixture.post_metrics.data = [];
    fixture.post_outcomes = { data: [], error: null };

    const report = await assembleMonthlyReport("ws-A", NOW);
    expect(report.quietMonth).toBe(true);
    expect(report.totals.posts).toBe(0);
    expect(report.posts).toHaveLength(0);
  });
});

// ── Renderer ───────────────────────────────────────────────────────────────
const theme: ResolvedTheme = {
  primary: "#0a0a0a",
  accent: "#2563eb",
  logoUrl: null,
  brandName: "Acme Agency",
};

function baseReport(over: Partial<Parameters<typeof renderMonthlyReportHtml>[0]["report"]> = {}) {
  return {
    workspaceId: "ws-A",
    month: previousCalendarMonth(NOW),
    posts: [],
    totals: { posts: 0, impressions: 0, engagements: 0, avgEngagementRate: null },
    channels: [],
    winningThemes: [],
    outcomes: { enabled: false, totalValueCents: 0, count: 0, items: [] },
    quietMonth: false,
    ...over,
  };
}

describe("renderMonthlyReportHtml", () => {
  it("renders the month label, totals, and the not-enabled outcomes note", () => {
    const html = renderMonthlyReportHtml({
      theme,
      workspaceName: "Client WS",
      report: baseReport({
        posts: [
          { id: "p1", text: "Launch day!", channel: "x", posted_at: "2026-05-10T00:00:00Z", impressions: 1000, likes: 50, reposts: 10, replies: 5, clicks: 2, engagement_rate: 0.067 },
        ],
        totals: { posts: 1, impressions: 1000, engagements: 67, avgEngagementRate: 0.067 },
      }),
      generatedAt: NOW,
    });
    expect(html).toContain("May 2026 report");
    expect(html).toContain("Posts shipped");
    expect(html).toContain("Launch day!");
    expect(html).toContain("Outcome tracking is not enabled");
  });

  it("renders the $ rollup when outcomes are present", () => {
    const html = renderMonthlyReportHtml({
      theme,
      workspaceName: "Client WS",
      report: baseReport({
        outcomes: {
          enabled: true,
          totalValueCents: 51500,
          count: 2,
          items: [
            { outcomeType: "sale", valueCents: 50000, note: "Enterprise deal" },
            { outcomeType: "lead", valueCents: 1500, note: null },
          ],
        },
      }),
      generatedAt: NOW,
    });
    expect(html).toContain("Business outcomes");
    expect(html).toContain("$515.00"); // total
    expect(html).toContain("$500.00"); // top item
    expect(html).toContain("Enterprise deal");
  });

  it("renders a graceful quiet-month report (not empty/broken)", () => {
    const html = renderMonthlyReportHtml({
      theme,
      workspaceName: "Client WS",
      report: baseReport({ quietMonth: true }),
      generatedAt: NOW,
    });
    expect(html).toContain("A quieter May 2026");
    // Post-by-post table is suppressed in a quiet month.
    expect(html).not.toContain("Post-by-post");
  });

  it("HTML-escapes post text + outcome notes (injection defense)", () => {
    const html = renderMonthlyReportHtml({
      theme,
      workspaceName: "Client WS",
      report: baseReport({
        posts: [
          { id: "p1", text: "<script>alert(1)</script>", channel: "x", posted_at: "2026-05-10T00:00:00Z", impressions: 1, likes: 0, reposts: 0, replies: 0, clicks: 0, engagement_rate: null },
        ],
        totals: { posts: 1, impressions: 1, engagements: 0, avgEngagementRate: null },
        outcomes: {
          enabled: true,
          totalValueCents: 100,
          count: 1,
          items: [{ outcomeType: "lead", valueCents: 100, note: "<img src=x onerror=alert(2)>" }],
        },
      }),
      generatedAt: NOW,
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<img src=x onerror=alert(2)>");
    expect(html).toContain("&lt;img src=x onerror=alert(2)&gt;");
  });
});
