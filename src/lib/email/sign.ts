import crypto from "node:crypto";

// Magic-link token helpers for the daily approval digest.
//
// A token is `<payload>.<sig>` where payload is base64url(JSON({postId, exp, action}))
// and sig is HMAC-SHA256(payload, EMAIL_LINK_SECRET) → base64url.
//
// The signed payload IS the auth for /api/approve and /api/reject — the routes
// have no other auth check beyond signature + exp, so be careful with the secret.

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export type LinkAction = "approve" | "reject";

export interface LinkPayload {
  postId: string;
  action: LinkAction;
  exp: number; // unix ms
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

export function signLinkToken(
  payload: Omit<LinkPayload, "exp"> & { exp?: number },
  secret: string,
  ttlMs: number = DEFAULT_TTL_MS,
): string {
  const exp = payload.exp ?? Date.now() + ttlMs;
  const body: LinkPayload = { postId: payload.postId, action: payload.action, exp };
  const encoded = b64urlEncode(Buffer.from(JSON.stringify(body), "utf8"));
  const sig = hmac(encoded, secret);
  return `${encoded}.${sig}`;
}

export type VerifyResult =
  | { ok: true; payload: LinkPayload }
  | { ok: false; reason: "malformed" | "bad-signature" | "expired" | "bad-payload" };

export function verifyLinkToken(token: string, secret: string): VerifyResult {
  if (typeof token !== "string" || !token.includes(".")) {
    return { ok: false, reason: "malformed" };
  }
  const dot = token.indexOf(".");
  const encoded = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!encoded || !sig) return { ok: false, reason: "malformed" };

  const expected = hmac(encoded, secret);
  // Constant-time compare to avoid timing side-channels on the signature.
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
    typeof (parsed as { postId?: unknown }).postId !== "string" ||
    typeof (parsed as { exp?: unknown }).exp !== "number" ||
    ((parsed as { action?: unknown }).action !== "approve" &&
      (parsed as { action?: unknown }).action !== "reject")
  ) {
    return { ok: false, reason: "bad-payload" };
  }
  const payload = parsed as LinkPayload;
  if (payload.exp < Date.now()) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}
