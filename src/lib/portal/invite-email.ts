// ─────────────────────────────────────────────────────────────
// Client portal invite email (agency → client share link)
// ─────────────────────────────────────────────────────────────
//
// Delivers an already-minted client portal/report link (src/lib/portal/manage.ts
// mints it; the org branding UI surfaces it) to a client contact by email,
// instead of the agency copy-pasting it into their own mail client. This is NOT
// client onboarding/login — it just emails the existing tokenized share link.
//
// Transport mirrors the established Resend pattern (memberships/invitations.ts +
// competitors/digest.ts): a raw fetch to the Resend API. GRACEFUL DEGRADE: when
// RESEND_API_KEY is unset the send is SKIPPED (status: "skipped"), never thrown
// — exactly like the digest cron. The caller surfaces "email not configured"
// rather than erroring.
//
// Optional org white-label branding (logo + accent colour) is applied when
// present, falling back to default marketingmagic styling otherwise.

import { serverEnv } from "@/lib/env";

const RESEND_URL = "https://api.resend.com/emails";

export interface InviteEmailBranding {
  orgName: string;
  logoUrl: string | null;
  colorAccent: string | null;
}

export interface RenderInviteEmailInput {
  workspaceName: string; // the client workspace the link is for
  portalUrl: string; // the full https://…/client/<token> share link
  scopes: string[]; // e.g. ["approve", "view_reports"] — drives the blurb
  branding: InviteEmailBranding;
}

const DEFAULT_ACCENT = "#2563eb";
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// What the holder can do, in plain language, from the token's scopes.
function scopeBlurb(scopes: string[]): string {
  const canApprove = scopes.includes("approve");
  const canReports = scopes.includes("view_reports");
  if (canApprove && canReports) return "review and approve drafts and see performance reports";
  if (canApprove) return "review and approve drafts";
  if (canReports) return "see performance reports";
  return "view your workspace";
}

export interface RenderedInviteEmail {
  subject: string;
  html: string;
  text: string;
}

export function renderInviteEmail(input: RenderInviteEmailInput): RenderedInviteEmail {
  const { workspaceName, portalUrl, scopes, branding } = input;
  const accent =
    branding.colorAccent && HEX_RE.test(branding.colorAccent)
      ? branding.colorAccent
      : DEFAULT_ACCENT;
  const senderName = branding.orgName.trim() || "your agency";
  const blurb = scopeBlurb(scopes);
  const subject = `${senderName} shared ${workspaceName} with you`;

  const logoBlock =
    branding.logoUrl && /^https?:\/\//.test(branding.logoUrl)
      ? `<img src="${esc(branding.logoUrl)}" alt="${esc(senderName)}" height="40" style="display:block;height:40px;max-width:200px;object-fit:contain;border:0;" />`
      : `<span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;color:#64748b;letter-spacing:0.06em;text-transform:uppercase;font-weight:600;">${esc(senderName)}</span>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f1f5f9;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="540" style="width:540px;max-width:540px;">
          <tr>
            <td style="padding:0 0 24px 0;">${logoBlock}</td>
          </tr>
          <tr>
            <td style="padding:0 0 12px 0;">
              <h1 style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:22px;line-height:1.3;color:#0f172a;font-weight:700;">
                Your ${esc(workspaceName)} portal is ready
              </h1>
            </td>
          </tr>
          <tr>
            <td style="padding:0 0 24px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.55;color:#475569;">
              <strong style="color:#0f172a;">${esc(senderName)}</strong> invited you to ${esc(blurb)} for
              <strong style="color:#0f172a;">${esc(workspaceName)}</strong>. No account needed — open your private link below.
            </td>
          </tr>
          <tr>
            <td style="padding:0 0 28px 0;">
              <a href="${esc(portalUrl)}" style="display:inline-block;background:${esc(accent)};color:#ffffff;text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;font-weight:600;padding:11px 22px;border-radius:8px;">Open your portal</a>
            </td>
          </tr>
          <tr>
            <td style="padding:0 0 24px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;line-height:1.55;color:#64748b;">
              Or paste this link in your browser:<br/>
              <span style="word-break:break-all;color:#475569;font-family:ui-monospace,SFMono-Regular,'SF Mono',Menlo,monospace;font-size:12px;">${esc(portalUrl)}</span>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 0 0 0;border-top:1px solid #e2e8f0;">
              <p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:12px;color:#94a3b8;line-height:1.55;">
                This link is private to you — keep it confidential. If you weren't expecting it, you can ignore this email.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = [
    `${senderName} shared ${workspaceName} with you.`,
    "",
    `You've been invited to ${blurb}. No account needed — open your private link:`,
    portalUrl,
    "",
    "Keep this link confidential. If you weren't expecting it, ignore this email.",
  ].join("\n");

  return { subject, html, text };
}

export type SendInviteEmailResult =
  | { status: "sent" }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

// Send the rendered invite via Resend. GRACEFUL DEGRADE: when RESEND_API_KEY is
// unset we LOG + SKIP (status "skipped") and NEVER throw — the share link still
// exists and can be copied manually, exactly like the digest cron's behaviour
// when email isn't configured. A real Resend HTTP/network failure returns
// "failed" (still no throw) so the caller can show a precise message.
export async function sendInviteEmail(
  to: string,
  rendered: RenderedInviteEmail,
): Promise<SendInviteEmailResult> {
  const env = serverEnv();
  if (!env.RESEND_API_KEY) {
    console.warn(
      "[portal-invite] RESEND_API_KEY unset — skipping client invite email; " +
        "the share link can still be copied manually.",
    );
    return { status: "skipped", reason: "email_not_configured" };
  }

  try {
    const resp = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      const reason = `resend ${resp.status}: ${body.slice(0, 200)}`;
      console.error(`[portal-invite] send failed: ${reason}`);
      return { status: "failed", reason };
    }
    return { status: "sent" };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "fetch failed";
    console.error(`[portal-invite] send threw: ${reason}`);
    return { status: "failed", reason };
  }
}
