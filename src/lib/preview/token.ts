// Signed preview tokens for the Magic Moment onboarding flow.
//
// Anonymous visitors enter a handle → we run voice extraction + plan
// generation → store the result in a signed HMAC token in the URL. The
// token IS the storage; nothing is persisted server-side. 24h TTL.
//
// Key reuse: we sign with CRON_SECRET (already required in env, ≥16 chars).
// This avoids a new env var. The secret is server-only — tokens are signed
// in server actions and verified in server components. The CRON_SECRET is
// already trusted for /api/cron route auth, so a leak would already be
// game-over; collocating with that trust boundary is intentional.

import { createHmac, timingSafeEqual } from "node:crypto";
import { serverEnv } from "@/lib/env";

export interface PreviewPayload {
  /** Channel the visitor entered (informational; used for UI copy). */
  channel: "x" | "linkedin" | "instagram" | "bluesky" | "threads";
  /** Raw handle as entered (no leading @). */
  handle: string;
  /** Optional niche / product hint inferred from form. */
  niche_hint?: string;
  /** The generated plan to render. Mirrors GeneratedPlan but kept loose to
   * avoid a coupling cycle with the plan schema. */
  plan: {
    plan_name: string;
    overview: string;
    posts: Array<{
      channel: string;
      text: string;
      theme: string;
      suggested_scheduled_at: string;
      rationale: string;
      image_prompt?: string;
    }>;
  };
  /** Short voice summary string we synthesized from the visitor's posts. */
  voice_summary: string;
  /** Whether we scraped via API or relied on paste fallback. */
  source: "scrape" | "paste";
  /** Issued-at, seconds since epoch. */
  iat: number;
  /** Expiry, seconds since epoch (24h after iat). */
  exp: number;
}

const TTL_SECONDS = 24 * 60 * 60;

function b64urlEncode(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function secret(): string {
  return serverEnv().CRON_SECRET;
}

/** Sign a preview payload. Adds `iat` and `exp` automatically. */
export function signPreviewToken(payload: Omit<PreviewPayload, "iat" | "exp">): string {
  const now = Math.floor(Date.now() / 1000);
  const full: PreviewPayload = { ...payload, iat: now, exp: now + TTL_SECONDS };
  const body = b64urlEncode(Buffer.from(JSON.stringify(full), "utf8"));
  const sig = createHmac("sha256", secret()).update(body).digest();
  return `${body}.${b64urlEncode(sig)}`;
}

export type VerifyResult =
  | { ok: true; payload: PreviewPayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

/** Verify a preview token. Constant-time signature check, then exp check. */
export function verifyPreviewToken(token: string): VerifyResult {
  if (typeof token !== "string" || !token.includes(".")) {
    return { ok: false, reason: "malformed" };
  }
  const [body, sig] = token.split(".");
  if (!body || !sig) return { ok: false, reason: "malformed" };

  let expected: Buffer;
  let provided: Buffer;
  try {
    expected = createHmac("sha256", secret()).update(body).digest();
    provided = b64urlDecode(sig);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: "bad_signature" };
  }

  let parsed: PreviewPayload;
  try {
    parsed = JSON.parse(b64urlDecode(body).toString("utf8")) as PreviewPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof parsed.exp !== "number" || now >= parsed.exp) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, payload: parsed };
}
