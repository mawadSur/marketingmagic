// ─────────────────────────────────────────────────────────────
// "What we learned & changed" weekly learning digest (Bet ①)
// ─────────────────────────────────────────────────────────────
//
// The email counterpart to the "Your winning themes" dashboard module. It
// makes the learning loop visible once a week:
//
//   • which THEMES are winning (loadThemeWinners — Bayesian-confident winners,
//     with lift vs the workspace baseline),
//   • what the AI review found (getOrGenerateAiReview — worked / struggled /
//     next actions),
//   • and a clear "your next plan leans into these winners" line so the user
//     sees the loop close: signal → review → next plan.
//
// This module is the COMPOSER only — it assembles the payload and renders the
// branded HTML. Delivery (Resend send, recipient resolution, CRON_SECRET gate)
// lives in /api/cron/learning-digest, mirroring the engagement-report cron.
//
// Visual language mirrors src/lib/email/engagement-report-template.ts so all
// transactional mail looks like one product (same card, palette, type ramp).
//
// COLD START: assembleLearningDigest returns null when there are NO confident
// winners AND NO AI review yet — the cron skips the send rather than mailing an
// empty digest.

import { loadThemeWinners, type ThemeWinner } from "@/lib/analytics/themes";
import { getOrGenerateAiReview, type AiReview } from "@/lib/dashboard/ai-review";

// How many winning themes to surface in the email. Matches loadThemeWinners'
// default cap so the email and the dashboard module stay in lockstep.
const MAX_WINNERS = 5;
// Cap the review list items so a chatty model can't blow up the email.
const MAX_REVIEW_ITEMS = 4;

export interface LearningDigestData {
  workspaceName: string;
  dateLabel: string; // e.g. "Sun, Jun 1"
  winners: ThemeWinner[]; // confident winners, highest lift first
  review: AiReview | null; // latest AI review (may be null on cold start)
  dashboardUrl: string;
  analyticsUrl: string;
}

// Assemble the digest payload for a workspace. Returns null on cold start
// (no confident winners AND no AI review) so the caller can skip the send.
//
// Resilient: if the AI review generation fails or is too thin, we still ship
// the winners (and vice-versa). Only when BOTH are empty do we bail.
export async function assembleLearningDigest(
  workspaceId: string,
  opts: { workspaceName: string; dashboardUrl: string; analyticsUrl: string },
): Promise<LearningDigestData | null> {
  // Pull both signals in parallel. Either may legitimately be empty/null.
  const [winners, review] = await Promise.all([
    loadThemeWinners(workspaceId, MAX_WINNERS).catch((err) => {
      console.warn(`[learning-digest] theme winners failed for ${workspaceId}:`, err);
      return [] as ThemeWinner[];
    }),
    getOrGenerateAiReview(workspaceId).catch((err) => {
      console.warn(`[learning-digest] AI review failed for ${workspaceId}:`, err);
      return null;
    }),
  ]);

  const hasReviewSignal =
    !!review &&
    (review.summary.trim().length > 0 ||
      review.themes_worked.length > 0 ||
      review.themes_struggled.length > 0 ||
      review.next_actions.length > 0);

  // COLD START — nothing learned yet. Skip.
  if (winners.length === 0 && !hasReviewSignal) return null;

  return {
    workspaceName: opts.workspaceName,
    dateLabel: new Date().toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    }),
    winners,
    review: hasReviewSignal ? review : null,
    dashboardUrl: opts.dashboardUrl,
    analyticsUrl: opts.analyticsUrl,
  };
}

// ─────────────────────────────────────────────────────────────
// HTML rendering — mirrors engagement-report-template.ts
// ─────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function liftLabel(lift: number): string {
  // lift is posterior_mean / baseline; >1 = above baseline.
  const pct = Math.round((lift - 1) * 100);
  return pct > 0 ? `+${pct}% vs your baseline` : `${pct}% vs your baseline`;
}

const SANS =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";

function winnerRow(w: ThemeWinner): string {
  return `
    <tr>
      <td style="padding:10px 8px;border-bottom:1px solid #eef0f3;font-family:${SANS};font-size:14px;font-weight:600;color:#1c1e21;">${esc(w.tag)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #eef0f3;text-align:right;font-family:${SANS};font-size:13px;color:#1877f2;font-weight:600;">${esc(liftLabel(w.lift))}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #eef0f3;text-align:right;font-family:${SANS};font-size:13px;color:#606770;">${w.posts} post${w.posts === 1 ? "" : "s"}</td>
    </tr>`;
}

function bulletList(items: string[], color: string): string {
  return items
    .slice(0, MAX_REVIEW_ITEMS)
    .map(
      (it) =>
        `<li style="font-family:${SANS};font-size:13px;line-height:1.55;color:${color};margin:0 0 6px;">${esc(it)}</li>`,
    )
    .join("");
}

function sectionLabel(text: string): string {
  return `<div style="font-family:${SANS};font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#8d949e;margin:0 0 8px;">${esc(text)}</div>`;
}

export function renderLearningDigest(data: LearningDigestData): string {
  const { workspaceName, dateLabel, winners, review } = data;

  const winnersBlock =
    winners.length > 0
      ? `
        <tr><td style="padding:16px 28px 0;">
          ${sectionLabel("Your winning themes")}
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
            ${winners.map(winnerRow).join("")}
          </table>
        </td></tr>`
      : "";

  // "Next plan leans into the winners" — the loop-closing line. When we have
  // confident winners we name them; otherwise we lean on the AI next actions.
  const leanInBlock = (() => {
    if (winners.length > 0) {
      const names = winners.map((w) => w.tag).slice(0, 3);
      const joined =
        names.length === 1
          ? `“${esc(names[0]!)}”`
          : names
              .map((n, i) =>
                i === names.length - 1 ? `and “${esc(n)}”` : `“${esc(n)}”`,
              )
              .join(", ");
      return `Your next plan leans into ${joined} — we'll generate more of what's working.`;
    }
    return "Your next plan leans into what the review found is working.";
  })();

  const summaryBlock = review?.summary
    ? `
      <tr><td style="padding:16px 28px 0;">
        ${sectionLabel("What the AI review found")}
        <div style="font-family:${SANS};font-size:14px;line-height:1.55;color:#1c1e21;">${esc(review.summary)}</div>
      </td></tr>`
    : "";

  const workedBlock =
    review && review.themes_worked.length > 0
      ? `
        <tr><td style="padding:14px 28px 0;">
          ${sectionLabel("What worked")}
          <ul style="margin:0;padding:0 0 0 18px;">${bulletList(review.themes_worked, "#1c1e21")}</ul>
        </td></tr>`
      : "";

  const struggledBlock =
    review && review.themes_struggled.length > 0
      ? `
        <tr><td style="padding:14px 28px 0;">
          ${sectionLabel("What struggled")}
          <ul style="margin:0;padding:0 0 0 18px;">${bulletList(review.themes_struggled, "#606770")}</ul>
        </td></tr>`
      : "";

  const nextActionsBlock =
    review && review.next_actions.length > 0
      ? `
        <tr><td style="padding:14px 28px 0;">
          ${sectionLabel("Next actions")}
          <ul style="margin:0;padding:0 0 0 18px;">${bulletList(review.next_actions, "#1c1e21")}</ul>
        </td></tr>`
      : "";

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f6f7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6f7;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
        <tr><td style="padding:24px 28px 8px;">
          <div style="font-family:${SANS};font-size:12px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#1877f2;">What we learned &amp; changed · ${esc(dateLabel)}</div>
          <h1 style="margin:6px 0 2px;font-family:${SANS};font-size:22px;color:#1c1e21;">${esc(workspaceName)}</h1>
          <div style="font-family:${SANS};font-size:13px;color:#606770;">The learning loop this week — what's winning, what the review found, and where your next plan is leaning.</div>
        </td></tr>

        ${winnersBlock}
        ${summaryBlock}
        ${workedBlock}
        ${struggledBlock}
        ${nextActionsBlock}

        <tr><td style="padding:18px 28px 0;">
          <div style="padding:14px 16px;border-radius:10px;background:#eef4ff;border:1px solid #d6e4ff;">
            <div style="font-family:${SANS};font-size:11px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:#1877f2;margin-bottom:6px;">Your next plan</div>
            <div style="font-family:${SANS};font-size:14px;line-height:1.55;color:#1c1e21;">${leanInBlock}</div>
          </div>
        </td></tr>

        <tr><td style="padding:18px 28px 28px;">
          <a href="${esc(data.dashboardUrl)}" style="display:inline-block;background:#1877f2;color:#ffffff;text-decoration:none;font-family:${SANS};font-size:14px;font-weight:600;padding:11px 18px;border-radius:8px;">See your winning themes →</a>
        </td></tr>
      </table>
      <div style="font-family:${SANS};font-size:11px;color:#8d949e;margin-top:14px;">Marketing Magic · weekly learning digest</div>
    </td></tr>
  </table>
</body></html>`;
}
