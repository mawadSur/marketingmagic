// Hand-rolled HTML email for the "connected but never published" activation
// nudge. Sibling of digest-template.ts — same table-based layout + inline CSS
// (every modern email client still parses tables more consistently than
// flexbox/grid, and Gmail strips <style> from the head when forwarding).
//
// Brand: slate gray neutrals + blue accent (#2563eb), 600px container — the
// de-facto safe width across desktop and mobile clients.
//
// Purpose: the workspace connected its first channel 2–3 days ago but has
// never shipped a post. This email re-engages that channel→published drop by
// pointing them at the one-click first-publish step in the onboarding wizard.

export interface ActivationNudgeInput {
  workspaceName: string;
  // Primary CTA — the wizard "done" step that publishes the first post in one
  // click. Falls back gracefully to the queue (rendered as the text link).
  publishUrl: string;
  // Fallback link surfaced as text — the full queue, in case the wizard CTA
  // doesn't fit the user's mental model.
  queueUrl: string;
}

// Minimal HTML-escape. The workspace name is operator-controlled but we escape
// it anyway since it ends up between tags / in href values.
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function activationNudgeSubject(workspaceName: string): string {
  return `Your first post is ready to ship — ${workspaceName}`;
}

export function renderActivationNudgeEmail(input: ActivationNudgeInput): string {
  const { workspaceName, publishUrl, queueUrl } = input;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Your first post is ready to ship</title>
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
              <h1 style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:24px;line-height:1.25;color:#0f172a;font-weight:700;">You're one click from your first post 🚀</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:0 0 28px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.55;color:#475569;">
              Nice work connecting your first channel to <strong style="color:#0f172a;">${esc(workspaceName)}</strong>. There's a post waiting in your queue, ready to go — but it hasn't shipped yet. Publishing your first post is what turns a setup into a habit. Let's get it live.
            </td>
          </tr>
          <tr>
            <td style="padding:0 0 8px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;">
                <tr>
                  <td style="padding:24px 24px 24px 24px;text-align:center;">
                    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.55;color:#1e293b;margin:0 0 18px 0;">
                      Your first post is drafted and waiting. One click publishes it.
                    </div>
                    <a href="${esc(publishUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;font-weight:600;padding:12px 26px;border-radius:8px;">Publish my first post &rarr;</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 0 0 0;text-align:center;">
              <span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;color:#64748b;">
                Prefer to review everything first? <a href="${esc(queueUrl)}" style="color:#2563eb;text-decoration:none;font-weight:600;">Open your queue &rarr;</a>
              </span>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 0 0 0;border-top:1px solid #e2e8f0;margin-top:32px;">
              <p style="margin:24px 0 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:12px;color:#94a3b8;line-height:1.55;text-align:center;">
                You're receiving this because you connected a channel on marketingmagic but haven't published yet.<br/>
                Once you ship your first post, these nudges stop.
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
