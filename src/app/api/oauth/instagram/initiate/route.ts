import { NextResponse, type NextRequest } from "next/server";
import { serverEnv, siteUrl } from "@/lib/env";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { instagramAuthorizeUrl } from "@/lib/social/instagram";
import { signOAuthState } from "@/lib/social/oauth-state";

// Start the Instagram (Instagram Login) OAuth flow. POST-only so a stray GET
// or prefetch can't trigger a token-allocation flow. Mirrors the X initiate
// pattern so the listing-page tile can POST here directly, instead of having
// to go through the per-channel page first.
//
// CSRF is carried in a SIGNED state param (signOAuthState) so the callback can
// verify the round-trip WITHOUT a cookie — mobile in-app browsers / the IG app
// deep-link / strict SameSite handling routinely drop the cookie, which used to
// 400 the callback ("can't connect Instagram on my phone"). The nonce cookie is
// still set as optional defense-in-depth, but is no longer required.

export async function POST(_req: NextRequest) {
  const env = serverEnv();
  if (!env.INSTAGRAM_APP_ID || !env.INSTAGRAM_APP_SECRET) {
    return NextResponse.redirect(
      new URL("/settings/channels/instagram?error=instagram_not_configured", siteUrl()),
    );
  }
  // getActiveWorkspaceOrRedirect handles auth + workspace bootstrap.
  const ws = await getActiveWorkspaceOrRedirect();

  const { state, nonce } = signOAuthState(ws.id);
  const redirectUri = `${siteUrl()}/api/oauth/instagram/callback`;
  const authorizeUrl = instagramAuthorizeUrl({ redirectUri, state });

  // 303 See Other (NOT the default 307). The /settings/channels tile POSTs to
  // this route; a 307 preserves the method, so the browser would POST to
  // instagram.com/oauth/authorize — which is GET-only and renders Instagram's
  // "Page isn't available" error (PolarisErrorRoute). 303 forces the browser to
  // follow with GET, which is what the OAuth authorize endpoint expects.
  const res = NextResponse.redirect(authorizeUrl, 303);
  res.cookies.set("ig_oauth_nonce", nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 10 * 60, // 10 min — comfortably above the human approval flow
    path: "/",
  });
  return res;
}
