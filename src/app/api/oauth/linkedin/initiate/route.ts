import { NextResponse, type NextRequest } from "next/server";
import { serverEnv, siteUrl } from "@/lib/env";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { linkedinAuthorizeUrl } from "@/lib/social/linkedin";
import { signOAuthState } from "@/lib/social/oauth-state";

// LinkedIn 3-legged OAuth initiation.
//
// Mirrors the server-action `startConnect` on /settings/channels/linkedin
// but exposes the flow as a normal GET endpoint so deep-links (digest
// emails, onboarding CTAs, etc.) can drop the user straight into LinkedIn's
// consent screen without first round-tripping through the settings page.
//
// Auth + workspace selection are handled by getActiveWorkspaceOrRedirect.
//
// CSRF is carried in a SIGNED state param (signOAuthState) so the callback can
// verify the round-trip WITHOUT a cookie — mobile in-app browsers / strict
// SameSite handling routinely drop the cookie, which used to 400 the callback
// ("can't connect LinkedIn on my phone"). The nonce cookie is still set as
// optional defense-in-depth, but is no longer required.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Shared handler. Exposed as BOTH GET and POST:
//   - POST is what the /settings/channels "Connect LinkedIn" tile submits (the
//     tile is a <form method="post"> like every other channel). Without a POST
//     export Next.js returns 405 and the button silently dies — this was the
//     "HTTP ERROR 405" the connect tile hit in production.
//   - GET keeps deep-links working (digest emails / onboarding CTAs that drop
//     the user straight into LinkedIn's consent screen without a form submit).
async function handle() {
  const env = serverEnv();
  const base = siteUrl();

  if (!env.LINKEDIN_CLIENT_ID || !env.LINKEDIN_CLIENT_SECRET) {
    return NextResponse.redirect(
      new URL("/settings/channels?error=linkedin_not_configured", base),
    );
  }

  const ws = await getActiveWorkspaceOrRedirect();
  const { state, nonce } = signOAuthState(ws.id);
  const redirectUri = `${base}/api/oauth/linkedin/callback`;
  const authorize = linkedinAuthorizeUrl({ redirectUri, state });

  // 303 See Other so the POST from the connect tile follows as a GET — the
  // authorize endpoint is GET-only (a method-preserving 307 would break it).
  const res = NextResponse.redirect(authorize, 303);
  // Scope the cookie path to the OAuth subtree — matches the X OAuth pattern
  // and means an attacker triggering an unrelated GET on the rest of the app
  // never sees this cookie. Callback reads at /api/oauth/linkedin/callback so
  // it's still in-scope.
  res.cookies.set("li_oauth_nonce", nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 10 * 60,
    path: "/api/oauth/linkedin",
  });
  return res;
}

export async function GET(_req: NextRequest) {
  return handle();
}

export async function POST(_req: NextRequest) {
  return handle();
}
