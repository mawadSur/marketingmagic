import { NextResponse, type NextRequest } from "next/server";
import { serverEnv, siteUrl } from "@/lib/env";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { xPkceChallenge, xAuthorizeUrl } from "@/lib/social/x";
import { signOAuthState } from "@/lib/social/oauth-state";

// Start the X OAuth 2.0 PKCE flow.
//
// 1. Generate a code_verifier (random 32B base64url) + matching code_challenge.
// 2. Generate a SIGNED state token (signOAuthState) for mobile-robust CSRF.
// 3. Stash { codeVerifier, workspaceId } in an httpOnly cookie — the callback
//    needs the verifier for PKCE token exchange (PKCE spec requires the verifier
//    server-side). The state is now self-verifying (signed), so the cookie only
//    holds the PKCE secret, not the CSRF token.
// 4. 302 to twitter.com/i/oauth2/authorize?... with the code_challenge.
//
// POST-only so a stray GET doesn't trigger a token-allocation flow and to
// keep the action behind a same-site form submission.
//
// PKCE note: Unlike other channels, X MUST keep a cookie for the code_verifier
// because PKCE requires it server-side for the /2/oauth2/token exchange. The
// signed state makes the CSRF check mobile-robust (survives cookie drops), but
// if the verifier cookie is missing the token exchange will fail — this is a
// PKCE limitation, not a bug. The verifier is a cryptographic secret (not CSRF).

export async function POST(_req: NextRequest) {
  const env = serverEnv();
  if (!env.X_CLIENT_ID || !env.X_CLIENT_SECRET) {
    return NextResponse.redirect(
      new URL("/settings/channels/x?error=x_not_configured", siteUrl()),
    );
  }

  // getActiveWorkspaceOrRedirect handles auth + workspace bootstrap.
  const ws = await getActiveWorkspaceOrRedirect();

  const base = siteUrl();
  const redirectUri = `${base}/api/oauth/x/callback`;

  const { codeVerifier, codeChallenge } = xPkceChallenge();
  const { state } = signOAuthState(ws.id);

  // Build the cookie payload. JSON-encoded → base64url. httpOnly so the
  // verifier (which is the actual PKCE secret) never touches the client.
  // The state is no longer in the cookie — it's self-verifying (signed).
  const stash = JSON.stringify({ v: codeVerifier, w: ws.id });
  const encoded = Buffer.from(stash, "utf8").toString("base64url");

  const authorizeUrl = xAuthorizeUrl({
    clientId: env.X_CLIENT_ID,
    redirectUri,
    state,
    codeChallenge,
  });

  // 303 See Other so the POST from the connect tile follows as a GET — the
  // authorize endpoint is GET-only (a method-preserving 307 would break it).
  const res = NextResponse.redirect(authorizeUrl, 303);
  res.cookies.set("x_oauth_state", encoded, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 10 * 60, // 10 minutes — well above the human approval flow
    path: "/api/oauth/x",
  });
  return res;
}
