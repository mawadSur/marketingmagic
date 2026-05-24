import { NextResponse, type NextRequest } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { serverEnv, siteUrl } from "@/lib/env";

// Meta's "Data Deletion Request Callback" endpoint.
//
// Meta calls this with a single form field `signed_request` shaped as
// `<base64url(HMAC-SHA256 of payload)>.<base64url(JSON payload)>`. The payload
// contains the Facebook user_id whose data should be deleted, plus algorithm
// + issued_at timestamps. We verify the HMAC using META_APP_SECRET so we
// don't act on forged requests, then return JSON with:
//   { url: "<status page>", confirmation_code: "<unique code>" }
//
// Meta surfaces that URL to the user so they can check on the deletion. The
// confirmation code is opaque to Meta — we encode timestamp + last bytes of
// the user_id hash so the same user always gets the same code (idempotent).
//
// Why this is required: Meta App Review will reject Instagram + Threads
// permissions without a working deletion callback. This is the contract.

interface SignedRequestPayload {
  algorithm: string;
  issued_at?: number;
  expires?: number;
  user_id: string;
}

// Meta uses base64url (RFC 4648) without padding. Node's Buffer accepts
// "base64url" since Node 16 — but be permissive about the padding either way.
function base64UrlDecode(s: string): Buffer {
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(padded, "base64url");
}

function verifySignedRequest(
  signedRequest: string,
  appSecret: string,
): SignedRequestPayload | null {
  const [sigPart, payloadPart] = signedRequest.split(".");
  if (!sigPart || !payloadPart) return null;

  const expectedSig = createHmac("sha256", appSecret).update(payloadPart).digest();
  const providedSig = base64UrlDecode(sigPart);

  // Lengths must match before timingSafeEqual — otherwise it throws.
  if (providedSig.length !== expectedSig.length) return null;
  if (!timingSafeEqual(providedSig, expectedSig)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(base64UrlDecode(payloadPart).toString("utf8"));
  } catch {
    return null;
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof (payload as Record<string, unknown>).algorithm !== "string" ||
    typeof (payload as Record<string, unknown>).user_id !== "string"
  ) {
    return null;
  }
  const algo = (payload as Record<string, unknown>).algorithm as string;
  if (algo !== "HMAC-SHA256") return null;

  return payload as SignedRequestPayload;
}

// Stable per-user code. Same Meta user_id always produces the same code so a
// user revisiting the status page sees their original request.
function confirmationCodeFor(userId: string): string {
  const h = createHmac("sha256", "marketingmagic-deletion-v1").update(userId).digest("hex");
  return `mm-${h.slice(0, 16)}`;
}

export async function POST(req: NextRequest) {
  const env = serverEnv();
  if (!env.META_APP_SECRET) {
    // App secret missing — we can't verify the signature, so we refuse rather
    // than silently accept anything Meta (or anyone else) sends.
    return NextResponse.json({ error: "meta_app_secret_not_configured" }, { status: 503 });
  }

  // Meta sends application/x-www-form-urlencoded with a single field.
  // We parse defensively in case they ever switch to JSON in a future API
  // version.
  let signedRequest: string | null = null;
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
    const form = await req.formData();
    const v = form.get("signed_request");
    if (typeof v === "string") signedRequest = v;
  } else if (ct.includes("application/json")) {
    try {
      const j = (await req.json()) as { signed_request?: unknown };
      if (typeof j.signed_request === "string") signedRequest = j.signed_request;
    } catch {
      /* fall through to error */
    }
  }
  if (!signedRequest) {
    return NextResponse.json({ error: "missing_signed_request" }, { status: 400 });
  }

  const payload = verifySignedRequest(signedRequest, env.META_APP_SECRET);
  if (!payload) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
  }

  const code = confirmationCodeFor(payload.user_id);

  // Log the request so the operator can audit / process it. Vercel keeps
  // function logs for the configured retention window. We deliberately do
  // NOT attempt automated cleanup of social_accounts here because the
  // Facebook user_id Meta sends does not directly match the IG/Threads
  // userId we store on the credentials row — a future enhancement should
  // capture the FB user_id at connect time to make this lookup possible.
  console.log("[data-deletion] received", {
    user_id: payload.user_id,
    issued_at: payload.issued_at,
    expires: payload.expires,
    code,
  });

  const url = `${siteUrl()}/data-deletion?code=${encodeURIComponent(code)}`;
  return NextResponse.json({ url, confirmation_code: code });
}

// Meta only ever POSTs here. A GET is most likely a human poking the URL —
// nudge them to the status page.
export async function GET() {
  return NextResponse.redirect(new URL("/data-deletion", siteUrl()));
}
