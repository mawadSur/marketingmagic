// Server-side renderer for the monthly proof-of-work client report (Agency
// Proof Engine, bet ③). Emits a self-contained, email-safe + print-optimized
// HTML document, white-labeled with the org's logo + colors. Built in the same
// shape as src/lib/portal/report-html.ts (same escaping discipline, same
// safeLogoTag, same hex-only colors) so the two reports look like one product;
// this one is the MONTHLY rollup and adds an outcomes/$ section + a graceful
// "quiet month" state.
//
// SECURITY: every value below is interpolated into HTML. We HTML-escape all
// text and only let validated hex colors / the stored logo URL through (the
// ResolvedTheme is already sanitized by resolveTheme), so no post text, outcome
// note, or branding field can inject markup.

import { type ResolvedTheme } from "@/lib/portal/branding";
import type { MonthlyClientReport } from "@/lib/client-report/assemble";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Only emit an <img> when the logo URL is an https URL; otherwise drop it.
// Mirrors the portal renderer's belt-and-suspenders guard.
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

// cents → "$1,234.56" (US). Used for the outcome/$ rollup.
function money(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export function renderMonthlyReportHtml(opts: {
  theme: ResolvedTheme;
  workspaceName: string;
  report: MonthlyClientReport;
  generatedAt: Date;
}): string {
  const { theme, workspaceName, report, generatedAt } = opts;
  const { totals, month } = report;

  // ── Quiet month: graceful, NOT empty/broken ──────────────────────────────
  const quietHtml = report.quietMonth
    ? `<div class="quiet">
        <h2>A quieter ${escapeHtml(month.label)}</h2>
        <p>No posts went out this month. That's completely fine — sometimes the
        plan is to listen, plan, and build. We'll be back with fresh content next
        month, and this report will fill up as soon as posts ship.</p>
      </div>`
    : "";

  // ── Outcomes / $ section ──────────────────────────────────────────────────
  // Three states: not enabled (dependency not landed) → explicit note; enabled
  // but empty → "no outcomes logged"; enabled with data → the rollup.
  let outcomesHtml = "";
  if (!report.outcomes.enabled) {
    outcomesHtml = `<h2 class="section">Business outcomes</h2>
      <p class="note">Outcome tracking is not enabled for this account yet. The
      figures above reflect reach &amp; engagement; once outcomes (leads, sales,
      revenue) are connected, they'll appear here in future reports.</p>`;
  } else if (report.outcomes.count === 0) {
    outcomesHtml = `<h2 class="section">Business outcomes</h2>
      <p class="note">No outcomes were logged this month.</p>`;
  } else {
    const itemsHtml = report.outcomes.items
      .map(
        (o) =>
          `<tr>
            <td>${escapeHtml(o.outcomeType)}</td>
            <td class="post">${o.note ? escapeHtml(o.note) : "—"}</td>
            <td class="num">${money(o.valueCents)}</td>
          </tr>`,
      )
      .join("");
    outcomesHtml = `<h2 class="section">Business outcomes</h2>
      <div class="stats two">
        <div class="stat"><div class="label">Tracked outcomes</div><div class="value">${fmt(
          report.outcomes.count,
        )}</div></div>
        <div class="stat"><div class="label">Attributed value</div><div class="value">${money(
          report.outcomes.totalValueCents,
        )}</div></div>
      </div>
      <table>
        <thead><tr><th>Outcome</th><th>Note</th><th class="num">Value</th></tr></thead>
        <tbody>${itemsHtml}</tbody>
      </table>`;
  }

  // ── Winning themes ─────────────────────────────────────────────────────────
  const themesHtml =
    report.winningThemes.length > 0
      ? `<h2 class="section">What's working — top themes</h2>
        <div class="chips">${report.winningThemes
          .map(
            (t) =>
              `<span class="chip"><b>${escapeHtml(t.tag)}</b> ${t.lift.toFixed(
                1,
              )}× baseline · ${t.posts} posts</span>`,
          )
          .join("")}</div>`
      : "";

  // ── Per-channel breakdown ────────────────────────────────────────────────
  const channelsHtml =
    report.channels.length > 0
      ? `<h2 class="section">By channel</h2>
        <table>
          <thead><tr>
            <th>Channel</th><th class="num">Posts</th>
            <th class="num">Impr.</th><th class="num">Eng. rate</th>
          </tr></thead>
          <tbody>${report.channels
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

  // ── Post-by-post ─────────────────────────────────────────────────────────
  const rowsHtml = report.posts
    .map((r) => {
      const eng = (r.likes ?? 0) + (r.reposts ?? 0) + (r.replies ?? 0) + (r.clicks ?? 0);
      const whenLabel = r.posted_at
        ? escapeHtml(new Date(r.posted_at).toISOString().slice(0, 10))
        : "—";
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

  // The post-by-post + breakdown sections are suppressed in a quiet month (the
  // quiet note carries the message instead), but the outcomes note still shows.
  const bodyHtml = report.quietMonth
    ? `${quietHtml}\n  ${outcomesHtml}`
    : `<div class="stats">
        <div class="stat"><div class="label">Posts shipped</div><div class="value">${fmt(
          totals.posts,
        )}</div></div>
        <div class="stat"><div class="label">Reach / impressions</div><div class="value">${fmt(
          totals.impressions,
        )}</div></div>
        <div class="stat"><div class="label">Engagements</div><div class="value">${fmt(
          totals.engagements,
        )}</div></div>
        <div class="stat"><div class="label">Avg. eng. rate</div><div class="value">${avgEr}</div></div>
      </div>

      ${outcomesHtml}
      ${themesHtml}
      ${channelsHtml}

      <h2 class="section">Post-by-post</h2>
      <table>
        <thead><tr>
          <th>Post</th><th>Channel</th><th>Date</th>
          <th class="num">Impr.</th><th class="num">Eng.</th><th class="num">Rate</th>
        </tr></thead>
        <tbody>${rowsHtml || `<tr><td colspan="6">No published posts in this period.</td></tr>`}</tbody>
      </table>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<title>${escapeHtml(theme.brandName)} — ${escapeHtml(month.label)} report</title>
<style>
  :root { --primary: ${theme.primary}; --accent: ${theme.accent}; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #111; margin: 0; padding: 32px; background: #fff; }
  .wrap { max-width: 720px; margin: 0 auto; }
  header { display: flex; align-items: center; gap: 16px; border-bottom: 3px solid var(--accent); padding-bottom: 20px; margin-bottom: 28px; }
  .logo { width: 56px; height: 56px; object-fit: contain; border-radius: 8px; }
  h1 { font-size: 22px; margin: 0; color: var(--primary); }
  .sub { color: #666; font-size: 13px; margin-top: 2px; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 28px; }
  .stats.two { grid-template-columns: repeat(2, 1fr); margin: 12px 0 16px; }
  .stat { border: 1px solid #e5e5e5; border-radius: 8px; padding: 12px; }
  .stat .label { font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: .04em; }
  .stat .value { font-size: 20px; font-weight: 600; color: var(--accent); margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; text-transform: uppercase; font-size: 10px; letter-spacing: .04em; color: #666; border-bottom: 2px solid #e5e5e5; padding: 8px 6px; }
  td { padding: 8px 6px; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.post { max-width: 320px; }
  td.chan { color: #666; }
  h2.section { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--primary); margin: 28px 0 10px; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip { border: 1px solid var(--accent); border-radius: 999px; padding: 4px 10px; font-size: 11px; color: #333; }
  .chip b { color: #111; }
  .note { color: #666; font-size: 13px; line-height: 1.5; }
  .quiet { border: 1px solid #e5e5e5; border-radius: 10px; padding: 24px; margin-bottom: 16px; }
  .quiet h2 { margin: 0 0 8px; font-size: 16px; color: var(--primary); }
  .quiet p { margin: 0; color: #555; font-size: 14px; line-height: 1.6; }
  footer { margin-top: 28px; color: #999; font-size: 11px; }
  @media print { body { padding: 0; } header { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      ${safeLogoTag(theme.logoUrl, theme.brandName)}
      <div>
        <h1>${escapeHtml(theme.brandName)}</h1>
        <div class="sub">${escapeHtml(workspaceName)} · ${escapeHtml(
          month.label,
        )} report · generated ${escapeHtml(generatedAt.toISOString().slice(0, 10))}</div>
      </div>
    </header>

    ${bodyHtml}

    <footer>Prepared by ${escapeHtml(
      theme.brandName,
    )}. Figures reflect the latest available metrics per post for ${escapeHtml(month.label)}.</footer>
  </div>
</body>
</html>`;
}
