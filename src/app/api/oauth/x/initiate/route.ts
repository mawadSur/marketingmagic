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

// Translate raw Twitter error strings into something a human can act on.
// Twitter's code 32 ("Could not authenticate you") at /oauth/request_token
// is the classic symptom of the wrong consumer credentials — almost always
// because the operator pasted the OAuth 2.0 Client ID/Secret into the env
// vars instead of the OAuth 1.0a API Key/Secret. Same dev portal, different
// section of "Keys and tokens".
function friendlyXError(raw: string): string {
  if (raw.includes('"code":32') || raw.includes("Could not authenticate you")) {
    return "X rejected the API credentials. Open developer.x.com → your app → Keys and tokens → 'Consumer Keys', and set X_CLIENT_ID = API Key, X_CLIENT_SECRET = API Secret (NOT the OAuth 2.0 Client ID/Secret).";
  }
  if (raw.includes('"code":89')) {
    return "X access token expired or invalid. Disconnect and re-authorize.";
  }
  if (raw.includes('"code":215')) {
    return "X authentication data missing. Check that both X_CLIENT_ID and X_CLIENT_SECRET are set on Vercel.";
  }
  return raw;
}

export async function POST(_req: NextRequest) {
  const env = serverEnv();
  if (!env.X_CLIENT_ID || !env.X_CLIENT_SECRET) {
    return NextResponse.redirect(
      new URL("/settings/channels/x?error=x_not_configured", siteUrl()),
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
    const raw = err instanceof Error ? err.message : "x_request_token_failed";
    const msg = friendlyXError(raw);
    return NextResponse.redirect(
      new URL(`/settings/channels/x?error=${encodeURIComponent(msg)}`, base),
    );
  }

  if (!token.oauth_callback_confirmed) {
    // Twitter rejected the callback URL. Most common cause: the app's
    // configured callback domain doesn't include the current host.
    return NextResponse.redirect(
      new URL(
        `/settings/channels/x?error=${encodeURIComponent(
          `X rejected the callback URL. Add ${callbackUrl} to your X app's Callback URI / Redirect URL list at developer.x.com.`,
        )}`,
        base,
      ),
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
