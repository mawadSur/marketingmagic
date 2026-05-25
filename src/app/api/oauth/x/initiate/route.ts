import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { serverEnv, siteUrl } from "@/lib/env";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { xPkceChallenge, xAuthorizeUrl } from "@/lib/social/x";

// Start the X OAuth 2.0 PKCE flow.
//
// 1. Generate a code_verifier (random 32B base64url) + matching code_challenge.
// 2. Generate a state token (CSRF binding).
// 3. Stash { codeVerifier, state, workspaceId } in an httpOnly cookie keyed
//    by the cookie name — the callback re-derives + verifies state.
// 4. 302 to twitter.com/i/oauth2/authorize?... with the code_challenge.
//
// POST-only so a stray GET doesn't trigger a token-allocation flow and to
// keep the action behind a same-site form submission.

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
  const state = crypto.randomBytes(16).toString("base64url");

  // Build the cookie payload. JSON-encoded → base64url. httpOnly so the
  // verifier (which is the actual secret) never touches the client.
  const stash = JSON.stringify({ v: codeVerifier, s: state, w: ws.id });
  const encoded = Buffer.from(stash, "utf8").toString("base64url");

  const authorizeUrl = xAuthorizeUrl({
    clientId: env.X_CLIENT_ID,
    redirectUri,
    state,
    codeChallenge,
  });

  const res = NextResponse.redirect(authorizeUrl);
  res.cookies.set("x_oauth_state", encoded, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 10 * 60, // 10 minutes — well above the human approval flow
    path: "/api/oauth/x",
  });
  return res;
}
