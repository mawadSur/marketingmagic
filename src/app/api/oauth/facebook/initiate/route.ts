import { NextResponse, type NextRequest } from "next/server";
import { serverEnv, siteUrl } from "@/lib/env";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { facebookAuthorizeUrl } from "@/lib/social/facebook";
import { signOAuthState } from "@/lib/social/oauth-state";
import { checkRateLimit } from "@/lib/rate-limit";

// Start the Facebook Page OAuth flow. POST-only so prefetches don't trigger
// a token allocation. Mirrors the X / IG / Threads initiate routes.
//
// CSRF is carried in a SIGNED state param (signOAuthState) so the callback can
// verify the round-trip WITHOUT a cookie — mobile in-app browsers / the FB app
// deep-link / strict SameSite handling routinely drop the cookie, which used to
// 400 the callback ("can't connect Facebook on my phone"). The nonce cookie is
// still set as optional defense-in-depth, but is no longer required.

export async function POST(_req: NextRequest) {
  const env = serverEnv();
  if (!env.META_APP_ID || !env.META_APP_SECRET || !env.META_FB_LOGIN_CONFIG_ID) {
    return NextResponse.redirect(
      new URL("/settings/channels/facebook?error=facebook_not_configured", siteUrl()),
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
  const redirectUri = `${siteUrl()}/api/oauth/facebook/callback`;
  const authorizeUrl = facebookAuthorizeUrl({ redirectUri, state });

  // 303 See Other so the POST from the connect tile follows as a GET — the
  // authorize endpoint is GET-only (a method-preserving 307 would break it).
  const res = NextResponse.redirect(authorizeUrl, 303);
  res.cookies.set("fb_oauth_nonce", nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 10 * 60,
    path: "/",
  });
  return res;
}
