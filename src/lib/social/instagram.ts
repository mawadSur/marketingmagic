// Instagram via the Instagram Graph API (Instagram API with Instagram Login).
//
// Users authorize directly with their Instagram Business/Creator account —
// no Facebook Page intermediary required. Two-step publish: create container
// with image_url, then publish.
//
// Auth: long-lived user access token with `instagram_business_basic` +
// `instagram_business_content_publish` (+ `instagram_business_manage_comments`
// for Phase 4.5 reply inbox once App Review lands).
//
// Endpoints differ from the older Facebook-Login-via-Pages path:
//   - Authorize:    https://www.instagram.com/oauth/authorize
//   - Short token:  https://api.instagram.com/oauth/access_token
//   - Long token:   https://graph.instagram.com/access_token?grant_type=ig_exchange_token
//   - Graph base:   https://graph.instagram.com

import { serverEnv } from "@/lib/env";
import { MetaAppReviewPendingError } from "@/lib/interactions/errors";

export interface InstagramCredentials {
  accessToken: string;
  expiresAt: string;
  igUserId: string; // numeric IG Business user id
}

const GRAPH = "https://graph.instagram.com";

export interface InstagramPostResult {
  id: string;
}

export interface InstagramMetrics {
  reach: number;
  impressions: number;
  likes: number;
  comments: number;
  shares: number;
  saved: number;
}

// ─── OAuth ─────────────────────────────────────────────────────────────────

export function instagramAuthorizeUrl(opts: { redirectUri: string; state: string }): string {
  const env = serverEnv();
  if (!env.INSTAGRAM_APP_ID) throw new Error("INSTAGRAM_APP_ID is not set.");
  const params = new URLSearchParams({
    client_id: env.INSTAGRAM_APP_ID,
    redirect_uri: opts.redirectUri,
    // IG Login flow scopes — note the `instagram_business_*` prefix vs the
    // older `instagram_*` names used on the FB Login path.
    scope: "instagram_business_basic,instagram_business_content_publish",
    response_type: "code",
    state: opts.state,
  });
  return `https://www.instagram.com/oauth/authorize?${params}`;
}

export async function instagramExchangeCode(opts: {
  code: string;
  redirectUri: string;
}): Promise<{ accessToken: string; igUserId: string; expiresAt: string }> {
  const env = serverEnv();
  if (!env.INSTAGRAM_APP_ID || !env.INSTAGRAM_APP_SECRET) {
    throw new Error("Instagram OAuth keys are not set.");
  }

  // 1. Authorization-code → short-lived user token (1 hour) on api.instagram.com.
  //    The IG Login flow uses form-encoded POST, not query-string GET like FB.
  const shortRes = await fetch("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.INSTAGRAM_APP_ID,
      client_secret: env.INSTAGRAM_APP_SECRET,
      grant_type: "authorization_code",
      redirect_uri: opts.redirectUri,
      code: opts.code,
    }),
  });
  if (!shortRes.ok) {
    throw new Error(`IG short token failed (${shortRes.status}): ${await shortRes.text()}`);
  }
  // Response is { access_token: "<token>", user_id: <number>, permissions: "..." }.
  // user_id arrives as a JSON number; coerce to string since downstream stores
  // it as text on social_accounts.credentials.
  const short = (await shortRes.json()) as {
    access_token: string;
    user_id: number | string;
    permissions?: string;
  };

  // 2. Exchange short-lived for long-lived (60-day) token on graph.instagram.com.
  const longRes = await fetch(
    `${GRAPH}/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(env.INSTAGRAM_APP_SECRET)}&access_token=${encodeURIComponent(short.access_token)}`,
  );
  if (!longRes.ok) {
    throw new Error(`IG long token failed (${longRes.status}): ${await longRes.text()}`);
  }
  const long = (await longRes.json()) as { access_token: string; expires_in: number };
  return {
    accessToken: long.access_token,
    igUserId: String(short.user_id),
    expiresAt: new Date(Date.now() + long.expires_in * 1000).toISOString(),
  };
}

export async function instagramVerify(accessToken: string, igUserId: string): Promise<{ username: string }> {
  // /me?fields=user_id,username works against graph.instagram.com on the
  // IG Login flow. We accept either /me or /<igUserId> here — using /me
  // sidesteps the rare edge case where the stored userId drifts from
  // what the token actually represents.
  const res = await fetch(
    `${GRAPH}/me?fields=username,user_id&access_token=${encodeURIComponent(accessToken)}`,
  );
  if (!res.ok) throw new Error(`IG verify failed (${res.status}): ${await res.text()}`);
  const json = (await res.json()) as { username: string; user_id?: string };
  // igUserId arg is kept for backwards-compat with callers; we don't need
  // it for the verify call but log a mismatch if it disagrees.
  if (json.user_id && igUserId && json.user_id !== igUserId) {
    console.warn(`IG verify: stored userId ${igUserId} != token's ${json.user_id}`);
  }
  return { username: json.username };
}

// ─── Posting ───────────────────────────────────────────────────────────────

export async function instagramPost(
  creds: InstagramCredentials,
  caption: string,
  imageUrl: string,
): Promise<InstagramPostResult> {
  // Container.
  const containerParams = new URLSearchParams({
    image_url: imageUrl,
    caption,
    access_token: creds.accessToken,
  });
  const cRes = await fetch(`${GRAPH}/${creds.igUserId}/media?${containerParams}`, { method: "POST" });
  if (!cRes.ok) throw new Error(`IG container failed (${cRes.status}): ${await cRes.text()}`);
  const { id: containerId } = (await cRes.json()) as { id: string };

  // Brief delay for image processing on Meta's side.
  await new Promise((r) => setTimeout(r, 3000));

  // Publish.
  const pRes = await fetch(
    `${GRAPH}/${creds.igUserId}/media_publish?creation_id=${containerId}&access_token=${encodeURIComponent(creds.accessToken)}`,
    { method: "POST" },
  );
  if (!pRes.ok) throw new Error(`IG publish failed (${pRes.status}): ${await pRes.text()}`);
  const pub = (await pRes.json()) as { id: string };
  return { id: pub.id };
}

// ─── Metrics ───────────────────────────────────────────────────────────────

export async function instagramMetrics(
  creds: InstagramCredentials,
  mediaId: string,
): Promise<InstagramMetrics> {
  const metrics = "reach,impressions,likes,comments,shares,saved";
  const res = await fetch(
    `${GRAPH}/${mediaId}/insights?metric=${metrics}&access_token=${encodeURIComponent(creds.accessToken)}`,
  );
  if (!res.ok) throw new Error(`IG metrics failed (${res.status}): ${await res.text()}`);
  const json = (await res.json()) as { data: Array<{ name: string; values: Array<{ value: number }> }> };
  const map = new Map<string, number>();
  for (const m of json.data ?? []) map.set(m.name, m.values?.[0]?.value ?? 0);
  return {
    reach: map.get("reach") ?? 0,
    impressions: map.get("impressions") ?? 0,
    likes: map.get("likes") ?? 0,
    comments: map.get("comments") ?? 0,
    shares: map.get("shares") ?? 0,
    saved: map.get("saved") ?? 0,
  };
}

// ─── Phase 4.5 (Reply Inbox + Engagement Assistant) ─────────────────────
//
// Stubs only. Reply + comment-pull paths require the
// `instagram_manage_comments` scope, which is gated on Meta App Review.
// We expose the helpers so call sites in the poller / send code path
// type-check, but every call throws MetaAppReviewPendingError. The /inbox
// UI catches this distinctly and renders a "coming soon" badge.

export async function instagramListComments(
  _creds: InstagramCredentials,
  _mediaId: string,
  _count = 25,
): Promise<never> {
  throw new MetaAppReviewPendingError("instagram_manage_comments");
}

export async function instagramReply(
  _creds: InstagramCredentials,
  _replyText: string,
  _parentCommentId: string,
): Promise<never> {
  throw new MetaAppReviewPendingError("instagram_manage_comments");
}
