// Discord custom_id signing.
//
// Discord caps button custom_id at 100 chars. The full base64url HMAC tokens
// from src/lib/email/sign.ts are way too long (190+ chars), so we use a
// purpose-shrunk variant: short prefix + post UUID + a truncated HMAC tag.
// Truncation is fine here because (a) we only verify exact matches, (b) the
// post UUID itself is in the payload so an attacker can't substitute one,
// and (c) the token is one-shot — once the post leaves pending_approval the
// action handler refuses to re-apply.
//
// Format: `mm:<action>:<postId>:<tag>` where tag is base64url(first 8 bytes
// of HMAC-SHA256(<action>:<postId>:<exp-iso-date>, EMAIL_LINK_SECRET)).
// The `exp` is bucketed to UTC midnight + 24h so the same token works for
// the whole day window (matches digest 14:00 UTC cron + 24h email TTL).
//
// We reuse EMAIL_LINK_SECRET because the security model is identical: the
// signed payload IS the auth, and rotating the secret invalidates both
// email and Discord magic links at once.

import crypto from "node:crypto";

export type DiscordAction = "approve" | "reject" | "edit";

const MAX_CUSTOM_ID = 100;
const TAG_BYTES = 8;
const TAG_HEX_LEN = TAG_BYTES * 2; // 16 hex chars

// Returns the UTC-midnight bucket two days ahead so a digest sent at 14:00
// UTC on day N is still valid at 14:00 UTC on day N+1. Using a 48h horizon
// gives us a clean overlap window without rolling tokens daily.
function expBucket(now: number = Date.now()): string {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 2);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function tag(material: string, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(material)
    .digest("hex")
    .slice(0, TAG_HEX_LEN);
}

export function signCustomId(
  action: DiscordAction,
  postId: string,
  secret: string,
  now: number = Date.now(),
): string {
  const exp = expBucket(now);
  const material = `${action}:${postId}:${exp}`;
  const t = tag(material, secret);
  const cid = `mm:${action}:${postId}:${t}`;
  if (cid.length > MAX_CUSTOM_ID) {
    // Discord will reject the button at send time. Fail loud in dev so the
    // length budget is preserved.
    throw new Error(`custom_id too long (${cid.length} > ${MAX_CUSTOM_ID})`);
  }
  return cid;
}

export type CustomIdVerifyResult =
  | { ok: true; action: DiscordAction; postId: string }
  | { ok: false; reason: "malformed" | "bad-action" | "bad-signature" };

export function verifyCustomId(customId: string, secret: string): CustomIdVerifyResult {
  if (typeof customId !== "string") return { ok: false, reason: "malformed" };
  const parts = customId.split(":");
  if (parts.length !== 4 || parts[0] !== "mm") {
    return { ok: false, reason: "malformed" };
  }
  const [, action, postId, supplied] = parts;
  if (action !== "approve" && action !== "reject" && action !== "edit") {
    return { ok: false, reason: "bad-action" };
  }
  if (!postId || !supplied) {
    return { ok: false, reason: "malformed" };
  }

  // Try the current bucket and the previous one. The current bucket is
  // midnight UTC two days ahead (see expBucket). The "previous" bucket is
  // the one we computed before midnight rolled — checking both gives us a
  // graceful overlap around UTC-midnight so a digest button sent at 23:59
  // UTC doesn't break at 00:01 UTC.
  const now = Date.now();
  const buckets = [expBucket(now), expBucket(now - 24 * 60 * 60 * 1000)];
  for (const exp of buckets) {
    const expected = tag(`${action}:${postId}:${exp}`, secret);
    if (timingSafeEqualHex(expected, supplied)) {
      return { ok: true, action: action as DiscordAction, postId };
    }
  }
  return { ok: false, reason: "bad-signature" };
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ─────────────────────────────────────────────────────────────
// Link-claim tokens (Phase 4.7 — multi-member attribution)
// ─────────────────────────────────────────────────────────────
// The Discord action handler issues these when an actor hits a button but
// hasn't been linked yet. The URL `/integrations/discord/link?token=…`
// verifies the token, then writes a discord_links row binding that Discord
// id to the now-authed Supabase user.
//
// Format mirrors src/lib/email/sign.ts on purpose — same secret
// (EMAIL_LINK_SECRET), same b64url(JSON).hmac shape, same constant-time
// compare. The two helpers live separately because the payload shape is
// different and conflating them would invite cross-token confusion.
// The Discord button helpers above are NOT reused here: they're shrunk to
// fit a 100-char custom_id and can't carry a structured payload.

const LINK_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface LinkClaimPayload {
  workspace_id: string;
  discord_user_id: string;
  discord_username: string;
  exp: number; // unix ms
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function hmacB64(payload: string, secret: string): string {
  return b64urlEncode(crypto.createHmac("sha256", secret).update(payload).digest());
}

export function signLinkClaimToken(
  payload: Omit<LinkClaimPayload, "exp"> & { exp?: number },
  secret: string,
  now: number = Date.now(),
): string {
  const body: LinkClaimPayload = {
    workspace_id: payload.workspace_id,
    discord_user_id: payload.discord_user_id,
    discord_username: payload.discord_username,
    exp: payload.exp ?? now + LINK_TOKEN_TTL_MS,
  };
  const encoded = b64urlEncode(Buffer.from(JSON.stringify(body), "utf8"));
  const sig = hmacB64(encoded, secret);
  return `${encoded}.${sig}`;
}

export type LinkClaimVerifyResult =
  | { ok: true; payload: LinkClaimPayload }
  | { ok: false; reason: "malformed" | "bad-signature" | "expired" | "bad-payload" };

export function verifyLinkClaimToken(token: string, secret: string): LinkClaimVerifyResult {
  if (typeof token !== "string" || !token.includes(".")) {
    return { ok: false, reason: "malformed" };
  }
  const dot = token.indexOf(".");
  const encoded = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!encoded || !sig) return { ok: false, reason: "malformed" };

  const expected = hmacB64(encoded, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad-signature" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(b64urlDecode(encoded).toString("utf8"));
  } catch {
    return { ok: false, reason: "bad-payload" };
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { workspace_id?: unknown }).workspace_id !== "string" ||
    typeof (parsed as { discord_user_id?: unknown }).discord_user_id !== "string" ||
    typeof (parsed as { discord_username?: unknown }).discord_username !== "string" ||
    typeof (parsed as { exp?: unknown }).exp !== "number"
  ) {
    return { ok: false, reason: "bad-payload" };
  }
  const payload = parsed as LinkClaimPayload;
  if (payload.exp < Date.now()) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}
