import crypto from "node:crypto";
import { serverEnv } from "@/lib/env";

// Signed OAuth `state` — mobile-robust CSRF for the channel-connect flows.
//
// WHY: every connect flow used to gate its callback on an httpOnly cookie
// (`<ch>_oauth_nonce`) matching the nonce embedded in `state`. That breaks on
// MOBILE — in-app browsers (opening the app from inside Instagram/Facebook/a
// webview), the IG/FB app intercepting the authorize deep-link, and stricter
// mobile Safari/ITP handling of SameSite=lax across the provider→us redirect
// all routinely DROP the cookie. The callback then 400s with "nonce mismatch"
// even though the user approved — the exact "can't connect Instagram on my
// phone" failure.
//
// FIX: make `state` SELF-VERIFYING. It carries {workspaceId, exp, nonce} and is
// HMAC-signed with a server secret. The callback validates the signature + exp
// from the URL alone — no cookie required, so it survives any browser context.
// The cookie is kept as optional defense-in-depth (verified IF present), but is
// no longer load-bearing.
//
// Token shape: `<base64url(JSON({w, exp, n}))>.<base64url(HMAC-SHA256)>`.
// Signed with CRON_SECRET (always set, min 16 chars) so no new env is needed.

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 min — matches the old cookie maxAge.

interface StatePayload {
  w: string; // workspaceId
  exp: number; // unix ms
  n: string; // random nonce (still mirrored into the cookie for defense-in-depth)
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}
function hmac(payload: string, secret: string): string {
  return b64urlEncode(crypto.createHmac("sha256", secret).update(payload).digest());
}
function secret(): string {
  // CRON_SECRET is required (min 16) so it's always present in every env.
  return serverEnv().CRON_SECRET;
}

export interface SignedState {
  // The signed `state` string to put in the authorize URL.
  state: string;
  // The raw nonce to ALSO drop in the httpOnly cookie (optional belt; the
  // signature is the real check). Lets callers keep the cookie if they want.
  nonce: string;
}

// Build a signed state for a workspace. `nonce` is returned so the caller can
// still set the legacy cookie as defense-in-depth.
export function signOAuthState(workspaceId: string, ttlMs: number = DEFAULT_TTL_MS): SignedState {
  const nonce = crypto.randomBytes(16).toString("hex");
  const body: StatePayload = { w: workspaceId, exp: Date.now() + ttlMs, n: nonce };
  const encoded = b64urlEncode(Buffer.from(JSON.stringify(body), "utf8"));
  const sig = hmac(encoded, secret());
  return { state: `${encoded}.${sig}`, nonce };
}

export type VerifyStateResult =
  | { ok: true; workspaceId: string; nonce: string }
  | { ok: false; reason: "malformed" | "bad-signature" | "expired" };

// Verify a signed state from the callback. Constant-time signature compare;
// rejects tampered or expired tokens. No cookie needed.
export function verifyOAuthState(state: string | null | undefined): VerifyStateResult {
  if (!state || !state.includes(".")) return { ok: false, reason: "malformed" };
  const [encoded, sig] = state.split(".");
  if (!encoded || !sig) return { ok: false, reason: "malformed" };

  const expected = hmac(encoded, secret());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad-signature" };
  }

  let payload: StatePayload;
  try {
    payload = JSON.parse(b64urlDecode(encoded).toString("utf8")) as StatePayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!payload.w || typeof payload.exp !== "number") return { ok: false, reason: "malformed" };
  if (Date.now() > payload.exp) return { ok: false, reason: "expired" };

  return { ok: true, workspaceId: payload.w, nonce: payload.n };
}
