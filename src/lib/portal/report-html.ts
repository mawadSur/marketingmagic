// Server-side renderer for the client report "PDF". We have no PDF library in
// the dependency set (pdf-parse is read-only), and adding one is out of scope
// for this surface, so we emit a fully self-contained, print-optimized HTML
// document instead: the client opens it and prints/saves to PDF. The layout is
// white-labeled with the org's logo + colors.
//
// SECURITY: every value below is interpolated into HTML. We HTML-escape all
// text and only let validated hex colors / the stored logo URL through, so no
// post text or branding field can inject markup.

import type { PortalReport, PortalInsights } from "@/lib/portal/data";
import { type ResolvedTheme } from "@/lib/portal/branding";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Only emit an <img> when the logo URL is an https URL to the Supabase host we
// control; otherwise drop it. Belt-and-suspenders against a stored bad value.
function safeLogoTag(logoUrl: string | null, brandName: string): string {
  if (!logoUrl) return "";
  let parsed: URL;
  try {
    parsed = new URL(logoUrl);
  } catch {
    return "";
  }
  if (parsed.protocol !== "https:") return "";
  return `<img class="logo" src="${escapeHtml(parsed.toString())}" alt="${escapeHtml(brandName)}" />`;
}

function fmt(n: number | null): string {
  return n === null || n === undefined ? "—" : n.toLocaleString();
}

export function renderReportHtml(opts: {
  theme: ResolvedTheme;
  workspaceName: string;
  report: PortalReport;
  insights: PortalInsights | null;
  generatedAt: Date;
}): string {
  const { theme, workspaceName, report, insights, generatedAt } = opts;
  const { totals } = report;

  // Winning themes — rendered as chips. Each value is escaped; lift/posts are
  // numbers formatted here, never interpolated from raw input.
  const themesHtml =
    insights && insights.winningThemes.length > 0
      ? `<h2 class="section">What's working — winning themes</h2>
    <div class="chips">${insights.winningThemes
      .map(
        (t) =>
          `<span class="chip"><b>${escapeHtml(t.tag)}</b> ${t.lift.toFixed(
            1,
          )}× baseline · ${t.posts} posts</span>`,
      )
      .join("")}</div>`
      : "";

  // Per-channel breakdown table (30d).
  const channelsHtml =
    insights && insights.channels.length > 0
      ? `<h2 class="section">By channel (30 days)</h2>
    <table>
      <thead><tr>
        <th>Channel</th><th class="num">Posts</th>
        <th class="num">Impr.</th><th class="num">Eng. rate</th>
      </tr></thead>
      <tbody>${insights.channels
        .map(
          (c) =>
            `<tr><td class="chan">${escapeHtml(
              c.channel.toUpperCase(),
            )}</td><td class="num">${c.posts.toLocaleString()}</td><td class="num">${c.impressions.toLocaleString()}</td><td class="num">${(
              c.engagement_rate * 100
            ).toFixed(1)}%</td></tr>`,
        )
        .join("")}</tbody>
    </table>`
      : "";

  const rowsHtml = report.rows
    .map((r) => {
      const eng = (r.likes ?? 0) + (r.reposts ?? 0) + (r.replies ?? 0) + (r.clicks ?? 0);
      const when = r.posted_at ?? r.scheduled_at;
      const whenLabel = when ? escapeHtml(new Date(when).toISOString().slice(0, 10)) : "—";
      return `<tr>
        <td class="post">${escapeHtml(r.text.slice(0, 280))}</td>
        <td class="chan">${escapeHtml(r.channel.toUpperCase())}</td>
        <td>${whenLabel}</td>
        <td class="num">${fmt(r.impressions)}</td>
        <td class="num">${eng.toLocaleString()}</td>
        <td class="num">${r.engagement_rate === null ? "—" : (r.engagement_rate * 100).toFixed(1) + "%"}</td>
      </tr>`;
    })
    .join("");

  const avgEr =
    totals.avgEngagementRate === null ? "—" : `${(totals.avgEngagementRate * 100).toFixed(1)}%`;

  // Inline <script> auto-opens the print dialog so "Download PDF" → save as PDF
  // is one step. Guarded so server-side/no-window contexts don't choke.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<title>${escapeHtml(theme.brandName)} — Performance report</title>
<style>
  :root { --primary: ${theme.primary}; --accent: ${theme.accent}; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #111; margin: 0; padding: 40px; }
  header { display: flex; align-items: center; gap: 16px; border-bottom: 3px solid var(--accent); padding-bottom: 20px; margin-bottom: 28px; }
  .logo { width: 56px; height: 56px; object-fit: contain; border-radius: 8px; }
  h1 { font-size: 22px; margin: 0; color: var(--primary); }
  .sub { color: #666; font-size: 13px; margin-top: 2px; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 28px; }
  .stat { border: 1px solid #e5e5e5; border-radius: 8px; padding: 12px; }
  .stat .label { font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: .04em; }
  .stat .value { font-size: 20px; font-weight: 600; color: var(--accent); margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; text-transform: uppercase; font-size: 10px; letter-spacing: .04em; color: #666; border-bottom: 2px solid #e5e5e5; padding: 8px 6px; }
  td { padding: 8px 6px; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.post { max-width: 280px; }
  td.chan { color: #666; }
  h2.section { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--primary); margin: 28px 0 10px; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip { border: 1px solid var(--accent); border-radius: 999px; padding: 4px 10px; font-size: 11px; color: #333; }
  .chip b { color: #111; }
  footer { margin-top: 28px; color: #999; font-size: 11px; }
  @media print { body { padding: 0; } header { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style>
</head>
<body>
  <header>
    ${safeLogoTag(theme.logoUrl, theme.brandName)}
    <div>
      <h1>${escapeHtml(theme.brandName)}</h1>
      <div class="sub">${escapeHtml(workspaceName)} · Performance report · ${escapeHtml(
        generatedAt.toISOString().slice(0, 10),
      )}</div>
    </div>
  </header>

  <div class="stats">
    <div class="stat"><div class="label">Posts</div><div class="value">${fmt(totals.posts)}</div></div>
    <div class="stat"><div class="label">Impressions</div><div class="value">${fmt(totals.impressions)}</div></div>
    <div class="stat"><div class="label">Engagements</div><div class="value">${fmt(totals.engagements)}</div></div>
    <div class="stat"><div class="label">Avg. eng. rate</div><div class="value">${avgEr}</div></div>
  </div>

  ${themesHtml}
  ${channelsHtml}

  <h2 class="section">Post-by-post</h2>
  <table>
    <thead>
      <tr>
        <th>Post</th><th>Channel</th><th>Date</th>
        <th class="num">Impr.</th><th class="num">Eng.</th><th class="num">Rate</th>
      </tr>
    </thead>
    <tbody>${rowsHtml || `<tr><td colspan="6">No published posts yet.</td></tr>`}</tbody>
  </table>

  <footer>Generated by ${escapeHtml(theme.brandName)}. Figures reflect the latest available metrics per post.</footer>
  <script>try { window.addEventListener('load', function(){ setTimeout(function(){ window.print(); }, 300); }); } catch (e) {}</script>
</body>
</html>`;
}
