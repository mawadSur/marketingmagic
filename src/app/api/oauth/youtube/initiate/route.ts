import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { serverEnv, siteUrl } from "@/lib/env";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { youtubeAuthorizeUrl } from "@/lib/social/youtube";

// Start the YouTube (Google) OAuth 2.0 flow. Mirrors the TikTok initiate route,
// minus PKCE — Google's web-client flow authenticates the token exchange with
// client_secret, so we only need a CSRF state token (no code_verifier).
//
// 1. Generate a state token (CSRF binding).
// 2. Stash { state, workspaceId } in an httpOnly cookie scoped to
//    /api/oauth/youtube — the callback verifies state.
// 3. 303 to accounts.google.com with access_type=offline + prompt=consent so
//    Google mints a refresh_token (without BOTH, the connection dies in ~1h).
//
// POST-only so a stray GET doesn't kick off a consent flow and to keep this
// behind a same-site submit.

export async function POST(_req: NextRequest) {
  const env = serverEnv();
  if (!env.YOUTUBE_CLIENT_ID || !env.YOUTUBE_CLIENT_SECRET) {
    return NextResponse.redirect(
      new URL("/settings/channels?error=youtube_not_configured", siteUrl()),
    );
  }

  // getActiveWorkspaceOrRedirect handles auth + workspace bootstrap.
  const ws = await getActiveWorkspaceOrRedirect();

  const base = siteUrl();
  const redirectUri = `${base}/api/oauth/youtube/callback`;

  const state = crypto.randomBytes(16).toString("base64url");

  // Cookie payload: JSON → base64url. httpOnly so it never touches the client.
  const stash = JSON.stringify({ s: state, w: ws.id });
  const encoded = Buffer.from(stash, "utf8").toString("base64url");

  const authorizeUrl = youtubeAuthorizeUrl({
    clientId: env.YOUTUBE_CLIENT_ID,
    redirectUri,
    state,
  });

  // 303 See Other so the POST from the connect tile follows as a GET — the
  // authorize endpoint is GET-only (a method-preserving 307 would break it).
  const res = NextResponse.redirect(authorizeUrl, 303);
  res.cookies.set("youtube_oauth_state", encoded, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 10 * 60, // 10 minutes — well above the human approval flow
    path: "/api/oauth/youtube",
  });
  return res;
}
