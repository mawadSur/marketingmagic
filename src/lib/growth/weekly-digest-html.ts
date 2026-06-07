// ─────────────────────────────────────────────────────────────
// Weekly Autonomous Growth Orchestrator — HTML renderer (Bet 5)
// ─────────────────────────────────────────────────────────────
//
// Renders the WeeklyGrowthDigest into a branded HTML email. Visual language
// mirrors src/lib/dashboard/learning-digest.ts (same SANS, palette, card,
// section-label ramp) so all transactional mail looks like one product.
//
// The email makes the loop visible: WHAT SHIPPED + WHAT IT DROVE ($/theme) +
// what the community autopilot did, then a "Recommended for next week" focus
// card. In DRAFT mode (the default) the focus card is explicitly framed as a
// recommendation the owner acts on — never an action already taken.

import { formatCents } from "@/lib/analytics/outcomes";
import { humanList, type WeeklyGrowthDigest } from "@/lib/growth/weekly-digest";

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function num(n: number): string {
  return n.toLocaleString("en-US");
}

function sectionLabel(text: string): string {
  return `<div style="font-family:${SANS};font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#8d949e;margin:0 0 8px;">${esc(text)}</div>`;
}

// The three headline numbers: posts / reach / engagement.
function statCell(value: string, label: string): string {
  return `
    <td style="padding:0 8px;text-align:center;">
      <div style="font-family:${SANS};font-size:22px;font-weight:700;color:#1c1e21;">${esc(value)}</div>
      <div style="font-family:${SANS};font-size:11px;color:#8d949e;text-transform:uppercase;letter-spacing:0.04em;">${esc(label)}</div>
    </td>`;
}

function themeRevenueRow(tag: string, revenue: string, outcomes: number): string {
  return `
    <tr>
      <td style="padding:10px 8px;border-bottom:1px solid #eef0f3;font-family:${SANS};font-size:14px;font-weight:600;color:#1c1e21;">${esc(tag)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #eef0f3;text-align:right;font-family:${SANS};font-size:13px;color:#1c8b4a;font-weight:600;">${esc(revenue)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #eef0f3;text-align:right;font-family:${SANS};font-size:13px;color:#606770;">${outcomes} outcome${outcomes === 1 ? "" : "s"}</td>
    </tr>`;
}

export function renderWeeklyGrowthDigest(data: WeeklyGrowthDigest): string {
  const {
    workspaceName,
    dateLabel,
    mode,
    shipped,
    revenueCents,
    themeRevenue,
    community,
    recommendedThemes,
    narrative,
  } = data;

  // Headline stat strip — posts / reach / engagement.
  const statsBlock = `
    <tr><td style="padding:18px 28px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tr>
          ${statCell(num(shipped.posts), "Posts shipped")}
          ${statCell(num(shipped.impressions), "Reach")}
          ${statCell(num(shipped.engagements), "Engagements")}
        </tr>
      </table>
    </td></tr>`;

  // Revenue-by-theme (Bet 1). Only shown when there's $/theme to show.
  const revenueRows = themeRevenue.filter((t) => t.revenueCents > 0 || t.outcomes > 0);
  const revenueBlock =
    revenueRows.length > 0
      ? `
        <tr><td style="padding:18px 28px 0;">
          ${sectionLabel("What it drove — outcomes by theme")}
          <div style="font-family:${SANS};font-size:13px;color:#606770;margin:0 0 8px;">${esc(formatCents(revenueCents))} in self-reported value this week.</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
            ${revenueRows.map((t) => themeRevenueRow(t.tag, formatCents(t.revenueCents), t.outcomes)).join("")}
          </table>
        </td></tr>`
      : "";

  // Bet 4 community autopilot summary — counts only, framed as "already fired".
  const communityActive =
    community.autoRepliesSent > 0 || community.dmsSent > 0 || community.blockedOrFailed > 0;
  const communityBlock = communityActive
    ? `
      <tr><td style="padding:18px 28px 0;">
        ${sectionLabel("Community autopilot — what it sent")}
        <div style="font-family:${SANS};font-size:14px;line-height:1.55;color:#1c1e21;">
          ${community.autoRepliesSent} auto-repl${community.autoRepliesSent === 1 ? "y" : "ies"} · ${community.dmsSent} DM${community.dmsSent === 1 ? "" : "s"} sent${community.leadsTagged > 0 ? ` · ${community.leadsTagged} lead${community.leadsTagged === 1 ? "" : "s"} captured` : ""}.
        </div>
        ${
          community.blockedOrFailed > 0
            ? `<div style="font-family:${SANS};font-size:12px;color:#8d949e;margin-top:4px;">${community.blockedOrFailed} attempt${community.blockedOrFailed === 1 ? "" : "s"} held back by your safety guards.</div>`
            : ""
        }
      </td></tr>`
    : "";

  // Recommended focus card — the loop-closing decision. In draft mode it's
  // explicitly a recommendation; in auto mode the copy acknowledges autonomy.
  const focusLine =
    recommendedThemes.length > 0
      ? `Lean into ${humanList(recommendedThemes.map((t) => `“${esc(t)}”`))} next week — that's where your $ and engagement are concentrating.`
      : "Keep shipping consistently — we'll surface a focus as soon as outcome and engagement signal accrues.";

  const modeNote =
    mode === "auto"
      ? "Autopilot is ON for this workspace — these are the themes the next cycle will favour."
      : "This is a recommendation. Nothing was published, replanned, or sent on your behalf — you decide what to act on.";

  const focusBlock = `
    <tr><td style="padding:18px 28px 0;">
      <div style="padding:14px 16px;border-radius:10px;background:#eef4ff;border:1px solid #d6e4ff;">
        <div style="font-family:${SANS};font-size:11px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:#1877f2;margin-bottom:6px;">Recommended for next week</div>
        <div style="font-family:${SANS};font-size:14px;line-height:1.55;color:#1c1e21;">${focusLine}</div>
        <div style="font-family:${SANS};font-size:12px;line-height:1.5;color:#606770;margin-top:8px;">${esc(modeNote)}</div>
      </div>
    </td></tr>`;

  // The narrative paragraph (Claude or deterministic) — escaped.
  const narrativeBlock = narrative
    ? `
      <tr><td style="padding:18px 28px 0;">
        ${sectionLabel("The week in a sentence")}
        <div style="font-family:${SANS};font-size:14px;line-height:1.6;color:#1c1e21;">${esc(narrative)}</div>
      </td></tr>`
    : "";

  const modeBadge =
    mode === "auto"
      ? `<span style="display:inline-block;font-family:${SANS};font-size:10px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#1c8b4a;background:#e6f6ec;padding:2px 8px;border-radius:999px;margin-left:8px;">Autopilot</span>`
      : `<span style="display:inline-block;font-family:${SANS};font-size:10px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#8d949e;background:#f0f1f3;padding:2px 8px;border-radius:999px;margin-left:8px;">Draft mode</span>`;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f6f7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6f7;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
        <tr><td style="padding:24px 28px 8px;">
          <div style="font-family:${SANS};font-size:12px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#1877f2;">Weekly growth recap · ${esc(dateLabel)}</div>
          <h1 style="margin:6px 0 2px;font-family:${SANS};font-size:22px;color:#1c1e21;">${esc(workspaceName)}${modeBadge}</h1>
          <div style="font-family:${SANS};font-size:13px;color:#606770;">What I did this week, what it drove, and where to lean next.</div>
        </td></tr>

        ${statsBlock}
        ${narrativeBlock}
        ${revenueBlock}
        ${communityBlock}
        ${focusBlock}

        <tr><td style="padding:18px 28px 28px;">
          <a href="${esc(data.analyticsUrl)}" style="display:inline-block;background:#1877f2;color:#ffffff;text-decoration:none;font-family:${SANS};font-size:14px;font-weight:600;padding:11px 18px;border-radius:8px;">See the full breakdown →</a>
        </td></tr>
      </table>
      <div style="font-family:${SANS};font-size:11px;color:#8d949e;margin-top:14px;">Marketing Magic · weekly growth orchestrator</div>
    </td></tr>
  </table>
</body></html>`;
}
