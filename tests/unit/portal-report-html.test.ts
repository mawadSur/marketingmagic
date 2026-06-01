import { describe, expect, it } from "vitest";

// ── Unit: report PDF/HTML renderer (src/lib/portal/report-html.ts) ───────────
//
// renderReportHtml emits a self-contained, white-labeled print document. The
// insights slice adds a winning-themes chip row + a per-channel table. Because
// every value is interpolated into HTML, theme tags / channel names MUST be
// HTML-escaped — this is the injection boundary for the report surface.

import { renderReportHtml } from "@/lib/portal/report-html";
import type { ResolvedTheme } from "@/lib/portal/branding";
import type { PortalReport, PortalInsights } from "@/lib/portal/data";

const theme: ResolvedTheme = {
  primary: "#0a0a0a",
  accent: "#2563eb",
  logoUrl: null,
  brandName: "Acme Agency",
};

const emptyReport: PortalReport = {
  rows: [],
  totals: { posts: 0, impressions: 0, engagements: 0, avgEngagementRate: null },
};

describe("renderReportHtml — insights", () => {
  it("renders winning themes and the per-channel breakdown", () => {
    const insights: PortalInsights = {
      channels: [
        { channel: "x", posts: 4, impressions: 1200, engagement: 60, engagement_rate: 0.05 },
      ],
      winningThemes: [
        { tag: "founder-story", posterior_mean: 0.08, ci_low: 0.06, ci_high: 0.1, posts: 6, lift: 1.6 },
      ],
    };
    const html = renderReportHtml({
      theme,
      workspaceName: "Client WS",
      report: emptyReport,
      insights,
      generatedAt: new Date("2026-06-01T00:00:00Z"),
    });

    expect(html).toContain("winning themes");
    expect(html).toContain("founder-story");
    expect(html).toContain("1.6× baseline");
    expect(html).toContain("By channel (30 days)");
    expect(html).toContain("X"); // channel uppercased
    expect(html).toContain("5.0%"); // engagement rate
  });

  it("HTML-escapes theme tags (injection defense)", () => {
    const insights: PortalInsights = {
      channels: [],
      winningThemes: [
        { tag: "<script>x</script>", posterior_mean: 0.1, ci_low: 0.08, ci_high: 0.12, posts: 3, lift: 2 },
      ],
    };
    const html = renderReportHtml({
      theme,
      workspaceName: "Client WS",
      report: emptyReport,
      insights,
      generatedAt: new Date("2026-06-01T00:00:00Z"),
    });

    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
  });

  it("omits the insights sections when there are none", () => {
    const html = renderReportHtml({
      theme,
      workspaceName: "Client WS",
      report: emptyReport,
      insights: { channels: [], winningThemes: [] },
      generatedAt: new Date("2026-06-01T00:00:00Z"),
    });
    expect(html).not.toContain("winning themes");
    expect(html).not.toContain("By channel");
  });
});
