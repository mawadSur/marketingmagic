// End-of-day engagement report email. Sibling of digest-template.ts (the
// approval digest) — same visual language, different payload: a per-channel
// roll-up of how the workspace's recently-published posts are performing,
// emailed to the owner once a day. Rendered server-side, sent via Resend by
// /api/cron/engagement-report.

export interface ChannelEngagement {
  channel: string;
  posts: number; // posts published in the window
  impressions: number;
  engagements: number; // likes + comments/replies + reposts/shares
  engagementRate: number | null; // 0..1, avg across posts that have a rate
}

export interface TopPost {
  channel: string;
  text: string;
  impressions: number;
  engagements: number;
}

export interface EngagementReportInput {
  workspaceName: string;
  dateLabel: string; // e.g. "Sun, Jun 1"
  windowDays: number; // size of the rollup window (e.g. 7)
  channels: ChannelEngagement[]; // sorted, highest engagement first
  totals: { posts: number; impressions: number; engagements: number };
  topPost: TopPost | null;
  dashboardUrl: string;
  analyticsUrl: string;
}

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

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length <= n ? t : t.slice(0, n - 1) + "…";
}

// Mirrors the channel palette in digest-template.ts so both emails look like
// one product. Unknown channels fall back to slate.
const PALETTE: Record<string, { bg: string; fg: string }> = {
  x: { bg: "#000000", fg: "#ffffff" },
  bluesky: { bg: "#1185fe", fg: "#ffffff" },
  linkedin: { bg: "#0a66c2", fg: "#ffffff" },
  instagram: { bg: "#c13584", fg: "#ffffff" },
  threads: { bg: "#000000", fg: "#ffffff" },
  facebook: { bg: "#1877f2", fg: "#ffffff" },
  tiktok: { bg: "#010101", fg: "#ffffff" },
};

function channelBadge(channel: string): string {
  const { bg, fg } = PALETTE[channel] ?? { bg: "#475569", fg: "#ffffff" };
  return `<span style="display:inline-block;padding:3px 10px;border-radius:999px;background:${bg};color:${fg};font-size:11px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">${esc(channel)}</span>`;
}

function channelRow(c: ChannelEngagement): string {
  const rate = c.engagementRate != null ? `${(c.engagementRate * 100).toFixed(2)}%` : "—";
  return `
    <tr>
      <td style="padding:10px 8px;border-bottom:1px solid #eef0f3;">${channelBadge(c.channel)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #eef0f3;text-align:right;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;color:#1c1e21;">${num(c.posts)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #eef0f3;text-align:right;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;color:#1c1e21;">${num(c.impressions)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #eef0f3;text-align:right;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;color:#1c1e21;">${num(c.engagements)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #eef0f3;text-align:right;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;color:#606770;">${rate}</td>
    </tr>`;
}

export function renderEngagementReport(input: EngagementReportInput): string {
  const { workspaceName, dateLabel, windowDays, channels, totals, topPost } = input;

  const rows = channels.map(channelRow).join("");

  const topPostCard = topPost
    ? `
    <div style="margin:20px 0;padding:16px;border:1px solid #eef0f3;border-radius:10px;background:#fafbfc;">
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:11px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:#606770;margin-bottom:8px;">Top post · ${channelBadge(topPost.channel)}</div>
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;color:#1c1e21;line-height:1.5;">${esc(truncate(topPost.text, 180))}</div>
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:12px;color:#606770;margin-top:8px;">${num(topPost.impressions)} impressions · ${num(topPost.engagements)} engagements</div>
    </div>`
    : "";

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f6f7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6f7;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
        <tr><td style="padding:24px 28px 8px;">
          <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:12px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#1877f2;">Daily engagement · ${esc(dateLabel)}</div>
          <h1 style="margin:6px 0 2px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:22px;color:#1c1e21;">${esc(workspaceName)}</h1>
          <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;color:#606770;">How your channels performed over the last ${windowDays} day${windowDays === 1 ? "" : "s"}.</div>
        </td></tr>

        <tr><td style="padding:16px 28px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
            <tr>
              <td style="padding:0 8px 8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:11px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:#8d949e;">Channel</td>
              <td style="padding:0 8px 8px;text-align:right;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:11px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:#8d949e;">Posts</td>
              <td style="padding:0 8px 8px;text-align:right;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:11px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:#8d949e;">Impr.</td>
              <td style="padding:0 8px 8px;text-align:right;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:11px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:#8d949e;">Engage</td>
              <td style="padding:0 8px 8px;text-align:right;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:11px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:#8d949e;">Rate</td>
            </tr>
            ${rows}
            <tr>
              <td style="padding:12px 8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;font-weight:700;color:#1c1e21;">Total</td>
              <td style="padding:12px 8px;text-align:right;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;font-weight:700;color:#1c1e21;">${num(totals.posts)}</td>
              <td style="padding:12px 8px;text-align:right;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;font-weight:700;color:#1c1e21;">${num(totals.impressions)}</td>
              <td style="padding:12px 8px;text-align:right;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;font-weight:700;color:#1c1e21;">${num(totals.engagements)}</td>
              <td style="padding:12px 8px;"></td>
            </tr>
          </table>
        </td></tr>

        <tr><td style="padding:0 28px;">${topPostCard}</td></tr>

        <tr><td style="padding:8px 28px 28px;">
          <a href="${esc(input.analyticsUrl)}" style="display:inline-block;background:#1877f2;color:#ffffff;text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;font-weight:600;padding:11px 18px;border-radius:8px;">View full analytics →</a>
        </td></tr>
      </table>
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:11px;color:#8d949e;margin-top:14px;">Marketing Magic · daily engagement report</div>
    </td></tr>
  </table>
</body></html>`;
}
