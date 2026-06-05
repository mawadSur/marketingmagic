import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { serverEnv, siteUrl } from "@/lib/env";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { threadsAuthorizeUrl } from "@/lib/social/threads";

// Start the Threads OAuth flow. POST-only; mirrors the X + IG initiate
// pattern so the listing-page tile can POST here directly.

export async function POST(_req: NextRequest) {
  const env = serverEnv();
  if (!env.THREADS_APP_ID || !env.THREADS_APP_SECRET) {
    return NextResponse.redirect(
      new URL("/settings/channels/threads?error=threads_not_configured", siteUrl()),
    );
  }
  const ws = await getActiveWorkspaceOrRedirect();

  const nonce = crypto.randomBytes(16).toString("hex");
  const state = `${ws.id}:${nonce}`;
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
