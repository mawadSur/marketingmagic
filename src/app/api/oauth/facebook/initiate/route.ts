import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { serverEnv, siteUrl } from "@/lib/env";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { facebookAuthorizeUrl } from "@/lib/social/facebook";

// Start the Facebook Page OAuth flow. POST-only so prefetches don't trigger
// a token allocation. Mirrors the X / IG / Threads initiate routes.

export async function POST(_req: NextRequest) {
  const env = serverEnv();
  if (!env.META_APP_ID || !env.META_APP_SECRET || !env.META_FB_LOGIN_CONFIG_ID) {
    return NextResponse.redirect(
      new URL("/settings/channels/facebook?error=facebook_not_configured", siteUrl()),
    );
  }
  const ws = await getActiveWorkspaceOrRedirect();

  const nonce = crypto.randomBytes(16).toString("hex");
  const state = `${ws.id}:${nonce}`;
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
