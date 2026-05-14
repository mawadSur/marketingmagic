// Hand-rolled HTML email for the daily approval digest. Table-based layout
// because every modern email client still parses tables more consistently
// than flexbox/grid. Inline CSS only — Gmail strips <style> tags from the
// document head when forwarding/quoting.
//
// Brand: slate gray neutrals + blue accent (#2563eb). Container is 600px,
// which is the de-facto safe width across desktop and mobile clients.

export interface DigestPost {
  id: string;
  channel: string;
  theme: string | null;
  text: string;
  scheduledAt: string | null;
}

// Phase 6.9: neglected-theme surfacing on the digest. The cron passes
// at most 2 entries — we render a compact card with a queue/regen link.
export interface DigestNeglectedTheme {
  theme: string;
  engagement_rate_30d: number;
  days_since_last_post: number;
}

export interface DigestTemplateInput {
  workspaceName: string;
  posts: DigestPost[];
  totalPending: number; // may be > posts.length when we truncate the list
  approveLinkFor: (postId: string) => string;
  rejectLinkFor: (postId: string) => string;
  queueUrl: string;
  // When present + non-empty, the digest renders a "neglected themes" card
  // above the approval cards. Suppressed entirely when undefined or empty.
  neglectedThemes?: DigestNeglectedTheme[];
  // Dashboard URL — landing page for the regen affordance. Optional so
  // callers that don't care can omit it; falls back to queueUrl.
  dashboardUrl?: string;
}

// Minimal HTML-escape. We only render trusted-ish strings (workspace name,
// post text, theme), but the post text comes from operators and AI output —
// so escape everything that ends up between tags or in href values.
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatScheduled(iso: string | null): string {
  if (!iso) return "Not scheduled";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Not scheduled";
  // Fixed format so email rendering is deterministic across timezones; we
  // append UTC so recipients aren't confused about when it'll ship.
  return `${d.toUTCString().replace(" GMT", " UTC")}`;
}

function truncate(s: string, n: number): string {
  const t = s.trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n - 1).trimEnd()}…`;
}

function channelBadge(channel: string): string {
  const palette: Record<string, { bg: string; fg: string }> = {
    x: { bg: "#0f172a", fg: "#ffffff" },
    instagram: { bg: "#db2777", fg: "#ffffff" },
    facebook: { bg: "#1d4ed8", fg: "#ffffff" },
    threads: { bg: "#111827", fg: "#ffffff" },
    bluesky: { bg: "#0284c7", fg: "#ffffff" },
    linkedin: { bg: "#0a66c2", fg: "#ffffff" },
  };
  const { bg, fg } = palette[channel] ?? { bg: "#475569", fg: "#ffffff" };
  return `<span style="display:inline-block;padding:3px 10px;border-radius:999px;background:${bg};color:${fg};font-size:11px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">${esc(channel)}</span>`;
}

function postCard(post: DigestPost, approveUrl: string, rejectUrl: string): string {
  const preview = esc(truncate(post.text, 160));
  const themePill = post.theme
    ? `<span style="display:inline-block;margin-left:8px;padding:3px 10px;border-radius:999px;background:#f1f5f9;color:#475569;font-size:11px;font-weight:500;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">${esc(post.theme)}</span>`
    : "";

  return `
  <tr>
    <td style="padding:0 0 16px 0;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;">
        <tr>
          <td style="padding:20px 22px 18px 22px;">
            <div style="margin-bottom:10px;">
              ${channelBadge(post.channel)}
              ${themePill}
            </div>
            <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.55;color:#1e293b;margin:0 0 14px 0;white-space:pre-wrap;">${preview}</div>
            <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:12px;color:#64748b;margin:0 0 18px 0;">
              <strong style="color:#475569;font-weight:600;">Scheduled:</strong> ${esc(formatScheduled(post.scheduledAt))}
            </div>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="padding-right:8px;">
                  <a href="${esc(approveUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;font-weight:600;padding:9px 18px;border-radius:8px;">Approve</a>
                </td>
                <td>
                  <a href="${esc(rejectUrl)}" style="display:inline-block;background:#ffffff;color:#475569;text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;font-weight:600;padding:8px 17px;border-radius:8px;border:1px solid #cbd5e1;">Reject</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>`;
}

function neglectedThemesCard(themes: DigestNeglectedTheme[], dashboardUrl: string): string {
  if (themes.length === 0) return "";
  const rows = themes
    .slice(0, 2)
    .map((t) => {
      const engagement = (t.engagement_rate_30d * 100).toFixed(2);
      return `
      <tr>
        <td style="padding:8px 0;border-bottom:1px solid #fef3c7;">
          <span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;color:#92400e;font-weight:600;">#${esc(t.theme)}</span>
          <span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:12px;color:#92400e;opacity:0.75;"> · ${engagement}% engagement · last posted ${t.days_since_last_post}d ago</span>
        </td>
      </tr>`;
    })
    .join("");
  return `
  <tr>
    <td style="padding:0 0 20px 0;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#fffbeb;border:1px solid #fde68a;border-radius:12px;">
        <tr>
          <td style="padding:18px 22px 14px 22px;">
            <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:11px;color:#92400e;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;margin-bottom:6px;">Neglected themes</div>
            <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;color:#78350f;line-height:1.5;margin-bottom:10px;">
              These top-quartile themes have gone quiet. Regenerate from the dashboard to keep the calendar balanced.
            </div>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
              ${rows}
            </table>
            <div style="padding-top:12px;">
              <a href="${esc(dashboardUrl)}" style="display:inline-block;background:#f59e0b;color:#ffffff;text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;font-weight:600;padding:8px 16px;border-radius:8px;">Open dashboard</a>
            </div>
          </td>
        </tr>
      </table>
    </td>
  </tr>`;
}

export function renderDigestEmail(input: DigestTemplateInput): string {
  const {
    workspaceName,
    posts,
    totalPending,
    approveLinkFor,
    rejectLinkFor,
    queueUrl,
    neglectedThemes,
    dashboardUrl,
  } = input;
  const cards = posts.map((p) => postCard(p, approveLinkFor(p.id), rejectLinkFor(p.id))).join("");
  const overflowNote =
    totalPending > posts.length
      ? `<tr><td style="padding:4px 0 16px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;color:#64748b;text-align:center;">+ ${totalPending - posts.length} more waiting in the queue.</td></tr>`
      : "";
  const neglectedCard =
    neglectedThemes && neglectedThemes.length > 0
      ? neglectedThemesCard(neglectedThemes, dashboardUrl ?? queueUrl)
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Posts awaiting your approval</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f1f5f9;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:600px;">
          <tr>
            <td style="padding:0 0 24px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;color:#64748b;letter-spacing:0.06em;text-transform:uppercase;font-weight:600;">marketingmagic</td>
          </tr>
          <tr>
            <td style="padding:0 0 8px 0;">
              <h1 style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:24px;line-height:1.25;color:#0f172a;font-weight:700;">Good morning ${esc(workspaceName)} 👋</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:0 0 28px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.55;color:#475569;">
              You have <strong style="color:#0f172a;">${totalPending} post${totalPending === 1 ? "" : "s"}</strong> waiting for approval. Approve or reject right from this email — no login required.
            </td>
          </tr>
          ${neglectedCard}
          ${cards}
          ${overflowNote}
          <tr>
            <td style="padding:8px 0 0 0;text-align:center;">
              <a href="${esc(queueUrl)}" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;color:#2563eb;text-decoration:none;font-weight:600;">Open the full queue &rarr;</a>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 0 0 0;border-top:1px solid #e2e8f0;margin-top:32px;">
              <p style="margin:24px 0 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:12px;color:#94a3b8;line-height:1.55;text-align:center;">
                Approve and reject links in this email are signed and expire in 24 hours.<br/>
                You're receiving this because you own a workspace on marketingmagic.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
