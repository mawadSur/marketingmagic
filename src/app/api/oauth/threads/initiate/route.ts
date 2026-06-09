import { NextResponse, type NextRequest } from "next/server";
import { serverEnv, siteUrl } from "@/lib/env";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { threadsAuthorizeUrl } from "@/lib/social/threads";
import { signOAuthState } from "@/lib/social/oauth-state";
import { checkRateLimit } from "@/lib/rate-limit";

// Start the Threads OAuth flow. POST-only; mirrors the X + IG initiate
// pattern so the listing-page tile can POST here directly.
//
// CSRF is carried in a SIGNED state param (signOAuthState) so the callback can
// verify the round-trip WITHOUT a cookie — mobile in-app browsers / the
// Threads app deep-link / strict SameSite handling routinely drop the cookie,
// which used to 400 the callback ("can't connect Threads on my phone"). The
// nonce cookie is still set as optional defense-in-depth, but is no longer
// required.

export async function POST(_req: NextRequest) {
  const env = serverEnv();
  if (!env.THREADS_APP_ID || !env.THREADS_APP_SECRET) {
    return NextResponse.redirect(
      new URL("/settings/channels/threads?error=threads_not_configured", siteUrl()),
    );
  }
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

  const { state, nonce } = signOAuthState(ws.id);
  const redirectUri = `${siteUrl()}/api/oauth/threads/callback`;
  const authorizeUrl = threadsAuthorizeUrl({ redirectUri, state });

  // 303 See Other so the POST from the connect tile follows as a GET — the
  // authorize endpoint is GET-only (a method-preserving 307 would break it).
  const res = NextResponse.redirect(authorizeUrl, 303);
  res.cookies.set("th_oauth_nonce", nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 10 * 60,
    path: "/",
  });
  return res;
}
