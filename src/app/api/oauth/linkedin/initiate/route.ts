import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { serverEnv, siteUrl } from "@/lib/env";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { linkedinAuthorizeUrl } from "@/lib/social/linkedin";

// LinkedIn 3-legged OAuth initiation.
//
// Mirrors the server-action `startConnect` on /settings/channels/linkedin
// but exposes the flow as a normal GET endpoint so deep-links (digest
// emails, onboarding CTAs, etc.) can drop the user straight into LinkedIn's
// consent screen without first round-tripping through the settings page.
//
// Auth + workspace selection are handled by getActiveWorkspaceOrRedirect.
// The CSRF nonce lives in a short-lived (10 min) httpOnly cookie and is
// echoed back via the OAuth `state` param — the callback enforces both.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  const env = serverEnv();
  const base = siteUrl();

  if (!env.LINKEDIN_CLIENT_ID || !env.LINKEDIN_CLIENT_SECRET) {
    return NextResponse.redirect(
      new URL("/settings/channels?error=linkedin_not_configured", base),
    );
  }

  const ws = await getActiveWorkspaceOrRedirect();
  const nonce = crypto.randomBytes(16).toString("hex");
  const state = `${ws.id}:${nonce}`;
  const redirectUri = `${base}/api/oauth/linkedin/callback`;
  const authorize = linkedinAuthorizeUrl({ redirectUri, state });

  const res = NextResponse.redirect(authorize);
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
