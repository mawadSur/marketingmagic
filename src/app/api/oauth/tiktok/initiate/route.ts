import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { serverEnv, siteUrl } from "@/lib/env";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { tiktokPkceChallenge, tiktokAuthorizeUrl } from "@/lib/social/tiktok";
import { checkRateLimit } from "@/lib/rate-limit";

// Start the TikTok OAuth 2.0 PKCE flow. Mirrors the X initiate route.
//
// 1. Generate a code_verifier (random 32B base64url) + matching code_challenge.
// 2. Generate a state token (CSRF binding).
// 3. Stash { codeVerifier, state, workspaceId } in an httpOnly cookie scoped to
//    /api/oauth/tiktok — the callback re-derives + verifies state.
// 4. 302 to www.tiktok.com/v2/auth/authorize/ with the code_challenge.
//
// ⚠️ TikTok specifics handled in tiktokAuthorizeUrl: `client_key` (not
// client_id) and a COMMA-separated scope string. POST-only so a stray GET
// doesn't kick off a consent flow and to keep this behind a same-site submit.

export async function POST(_req: NextRequest) {
  const env = serverEnv();
  if (!env.TIKTOK_CLIENT_KEY || !env.TIKTOK_CLIENT_SECRET) {
    return NextResponse.redirect(
      new URL("/settings/channels/tiktok?error=tiktok_not_configured", siteUrl()),
    );
  }

  // getActiveWorkspaceOrRedirect handles auth + workspace bootstrap.
  const ws = await getActiveWorkspaceOrRedirect();

  // Rate limit per workspace (20 requests per minute). Prevents OAuth initiate
  // abuse. When Upstash is unconfigured, this is a no-op (allows all).
  const limit = await checkRateLimit("oauth-initiate", ws.id, 20, 60_000);
  if (!limit.ok) {
    return NextResponse.redirect(
      new URL("/settings/channels?error=rate_limited", siteUrl()),
      303,
    );
  }

  const base = siteUrl();
  const redirectUri = `${base}/api/oauth/tiktok/callback`;

  const { codeVerifier, codeChallenge } = tiktokPkceChallenge();
  const state = crypto.randomBytes(16).toString("base64url");

  // Cookie payload: JSON → base64url. httpOnly so the verifier (the actual
  // secret) never touches the client.
  const stash = JSON.stringify({ v: codeVerifier, s: state, w: ws.id });
  const encoded = Buffer.from(stash, "utf8").toString("base64url");

  const authorizeUrl = tiktokAuthorizeUrl({
    clientKey: env.TIKTOK_CLIENT_KEY,
    redirectUri,
    state,
    codeChallenge,
  });

  // 303 See Other so the POST from the connect tile follows as a GET — the
  // authorize endpoint is GET-only (a method-preserving 307 would break it).
  const res = NextResponse.redirect(authorizeUrl, 303);
  res.cookies.set("tiktok_oauth_state", encoded, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 10 * 60, // 10 minutes — well above the human approval flow
    path: "/api/oauth/tiktok",
  });
  return res;
}
