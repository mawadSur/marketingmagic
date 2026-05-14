// Workspace invitation tokens + email rendering.
//
// Mirrors the magic-link pattern from src/lib/email/sign.ts: an opaque
// HMAC-signed token where the payload IS the auth. The /invite/[token]
// acceptance page verifies the signature, looks up the invitation row,
// and (if the row is still pending) inserts a membership.
//
// Why a server-side row in addition to a signed token:
//   * Owner can revoke a pending invite before it's accepted.
//   * accepted_at flips on first use so a leaked link can't be reused.
//   * Pending invites are visible in /settings/team without re-decoding
//     every token in the table.
//
// Falls back gracefully when EMAIL_LINK_SECRET or RESEND_API_KEY are not
// configured. In dev / preview environments without a Resend key, the
// magic link is surfaced in the UI for the owner to share manually.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export type InvitationRole = "editor" | "viewer";

export interface InvitationPayload {
  /** workspace_invitations.id (uuid). */
  invitationId: string;
  /** workspace_invitations.workspace_id, for sanity-check on accept. */
  workspaceId: string;
  /** Email the invite was issued to. Lowercased. */
  email: string;
  /** Issued-at, seconds since epoch. */
  iat: number;
  /** Expiry, seconds since epoch (7d after iat). */
  exp: number;
  /** Random nonce so two invites to the same email don't collide. */
  nonce: string;
}

function b64urlEncode(bytes: Buffer): string {
  return bytes
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

export function signInvitationToken(
  payload: Omit<InvitationPayload, "iat" | "exp" | "nonce">,
  secret: string,
): { token: string; expiresAt: Date } {
  const now = Math.floor(Date.now() / 1000);
  const full: InvitationPayload = {
    ...payload,
    iat: now,
    exp: now + TTL_SECONDS,
    nonce: randomBytes(8).toString("hex"),
  };
  const body = b64urlEncode(Buffer.from(JSON.stringify(full), "utf8"));
  const sig = createHmac("sha256", secret).update(body).digest();
  return {
    token: `${body}.${b64urlEncode(sig)}`,
    expiresAt: new Date(full.exp * 1000),
  };
}

export type VerifyInvitationResult =
  | { ok: true; payload: InvitationPayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "bad_payload" };

export function verifyInvitationToken(token: string, secret: string): VerifyInvitationResult {
  if (typeof token !== "string" || !token.includes(".")) {
    return { ok: false, reason: "malformed" };
  }
  const [body, sig] = token.split(".");
  if (!body || !sig) return { ok: false, reason: "malformed" };

  let expected: Buffer;
  let provided: Buffer;
  try {
    expected = createHmac("sha256", secret).update(body).digest();
    provided = b64urlDecode(sig);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: "bad_signature" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(b64urlDecode(body).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { invitationId?: unknown }).invitationId !== "string" ||
    typeof (parsed as { workspaceId?: unknown }).workspaceId !== "string" ||
    typeof (parsed as { email?: unknown }).email !== "string" ||
    typeof (parsed as { iat?: unknown }).iat !== "number" ||
    typeof (parsed as { exp?: unknown }).exp !== "number"
  ) {
    return { ok: false, reason: "bad_payload" };
  }

  const payload = parsed as InvitationPayload;
  const now = Math.floor(Date.now() / 1000);
  if (now >= payload.exp) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}

// ─── Email template ────────────────────────────────────────────────────

export interface InvitationEmailInput {
  workspaceName: string;
  inviterEmail: string;
  inviteUrl: string;
  role: InvitationRole;
  expiresAt: Date;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderInvitationEmail(input: InvitationEmailInput): {
  subject: string;
  html: string;
  text: string;
} {
  const { workspaceName, inviterEmail, inviteUrl, role, expiresAt } = input;
  const subject = `You're invited to join ${workspaceName} on marketingmagic`;
  const expiry = expiresAt.toUTCString().replace(" GMT", " UTC");

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
            <td style="padding:0 0 24px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;color:#64748b;letter-spacing:0.06em;text-transform:uppercase;font-weight:600;">marketingmagic</td>
          </tr>
          <tr>
            <td style="padding:0 0 12px 0;">
              <h1 style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:22px;line-height:1.3;color:#0f172a;font-weight:700;">
                You're invited to join ${esc(workspaceName)}
              </h1>
            </td>
          </tr>
          <tr>
            <td style="padding:0 0 24px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.55;color:#475569;">
              <strong style="color:#0f172a;">${esc(inviterEmail)}</strong> invited you to collaborate on
              <strong style="color:#0f172a;">${esc(workspaceName)}</strong> as ${esc(role === "editor" ? "an editor" : "a viewer")}.
            </td>
          </tr>
          <tr>
            <td style="padding:0 0 28px 0;">
              <a href="${esc(inviteUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;font-weight:600;padding:11px 22px;border-radius:8px;">Accept invitation</a>
            </td>
          </tr>
          <tr>
            <td style="padding:0 0 24px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;line-height:1.55;color:#64748b;">
              Or paste this link in your browser:<br/>
              <span style="word-break:break-all;color:#475569;font-family:ui-monospace,SFMono-Regular,'SF Mono',Menlo,monospace;font-size:12px;">${esc(inviteUrl)}</span>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 0 0 0;border-top:1px solid #e2e8f0;">
              <p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:12px;color:#94a3b8;line-height:1.55;">
                This invitation expires ${esc(expiry)}. If you weren't expecting it, ignore this email and the link will silently expire.
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
    `You're invited to join ${workspaceName} on marketingmagic.`,
    "",
    `${inviterEmail} invited you to collaborate as ${role === "editor" ? "an editor" : "a viewer"}.`,
    "",
    `Accept the invitation:`,
    inviteUrl,
    "",
    `This link expires ${expiry}.`,
  ].join("\n");

  return { subject, html, text };
}

// ─── Email send (Resend, raw fetch) ────────────────────────────────────

export interface SendInvitationEmailParams extends InvitationEmailInput {
  to: string;
  apiKey: string;
  from: string;
}

export interface SendInvitationEmailResult {
  ok: boolean;
  error?: string;
}

const RESEND_URL = "https://api.resend.com/emails";

export async function sendInvitationEmail(
  params: SendInvitationEmailParams,
): Promise<SendInvitationEmailResult> {
  const { subject, html, text } = renderInvitationEmail(params);
  try {
    const resp = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: params.from,
        to: params.to,
        subject,
        html,
        text,
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { ok: false, error: `resend ${resp.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "fetch failed",
    };
  }
}
