import { NextResponse, type NextRequest } from "next/server";
import { serverEnv, siteUrl } from "@/lib/env";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { xRequestToken, xAuthorizeUrl } from "@/lib/social/x";

// Start the X 3-legged OAuth flow. Hits Twitter's /oauth/request_token,
// stashes the request token secret in a short-lived httpOnly cookie keyed by
// the request token (which doubles as the CSRF binding — the callback verifies
// the oauth_token query matches the stashed token), then 302s the browser to
// /oauth/authorize.
//
// POST-only so a stray GET doesn't trigger a token-allocation flow (and to
// keep the action behind a same-site form submission). The settings UI posts
// a hidden form.

export async function POST(_req: NextRequest) {
  const env = serverEnv();
  if (!env.X_CLIENT_ID || !env.X_CLIENT_SECRET) {
    return NextResponse.redirect(
      new URL("/settings/channels?error=x_not_configured", siteUrl()),
    );
  }
  // getActiveWorkspaceOrRedirect handles auth + workspace bootstrap.
  // It internally redirects to /login or /onboarding/workspace if needed.
  const ws = await getActiveWorkspaceOrRedirect();

  const base = siteUrl();
  const callbackUrl = `${base}/api/oauth/x/callback`;

  let token: Awaited<ReturnType<typeof xRequestToken>>;
  try {
    token = await xRequestToken({
      apiKey: env.X_CLIENT_ID,
      apiSecret: env.X_CLIENT_SECRET,
      callbackUrl,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "x_request_token_failed";
    return NextResponse.redirect(
      new URL(`/settings/channels?error=${encodeURIComponent(msg)}`, base),
    );
  }

  if (!token.oauth_callback_confirmed) {
    // Twitter rejected the callback URL. Most common cause: the app's
    // configured callback domain doesn't include the current host.
    return NextResponse.redirect(
      new URL("/settings/channels?error=x_callback_not_confirmed", base),
    );
  }

  // Build the state cookie. JSON-encoded then base64; httpOnly so the
  // oauth_token_secret never touches the client. The cookie is bound to the
  // request token — the callback verifies the oauth_token query param matches
  // the stashed token, which prevents CSRF (an attacker can't forge a callback
  // that matches their own cookie).
  const state = JSON.stringify({
    t: token.oauth_token,
    s: token.oauth_token_secret,
    w: ws.id,
  });
  const encoded = Buffer.from(state, "utf8").toString("base64url");

  const res = NextResponse.redirect(xAuthorizeUrl(token.oauth_token));
  res.cookies.set("x_oauth_state", encoded, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 10 * 60, // 10 minutes — well above the human approval flow
    path: "/api/oauth/x",
  });
  return res;
}
