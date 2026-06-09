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
//
// NOTE (Page-picker, 2026-05-31): Facebook now has a multi-Page picker
// (/settings/channels/facebook/select-target) so an agency operator can map a
// specific Page to the active client workspace. Instagram does NOT need an
// analogous picker under THIS flow: the Instagram-Login token exchange resolves
// exactly one IG Business account (`igUserId`) — there is no candidate set to
// choose from. The same is true for Threads (one Threads user per token). A
// picker would only become relevant if we migrated IG back to the
// Facebook-Login-via-Pages path (list Pages → their linked IG Business
// accounts, multiple of which one operator could manage); if/when we do that,
// mirror facebook.ts (FacebookPageCandidate + a pending-row stash) here.

import { serverEnv } from "@/lib/env";
import { MetaAppReviewPendingError } from "@/lib/interactions/errors";
import { RetryableError } from "./errors";

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
    // Log the FACT of a mismatch, not the ids themselves (an IG user id ties a
    // workspace to a real account — keep it out of logs).
    console.warn("IG verify: stored userId does not match the token's userId");
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

  // Poll the container to FINISHED rather than a blind sleep — images finish in
  // a couple seconds but publishing before FINISHED returns HTTP 400.
  await pollContainerStatus(containerId, creds.accessToken, {
    initialDelayMs: 0,
    intervalMs: 3000,
    timeoutMs: 60 * 1000,
  });
  return publishContainer(creds, containerId);
}

// ─── Video (Reels) ───────────────────────────────────────────────────────────
//
// IG video = Reels only. There is no feed-video container type on the Instagram
// Graph API — REELS is the single video media_type. Same URL-pull + container +
// poll + publish shape as images, but transcode is slower so the poll budget is
// larger. `share_to_feed` surfaces the Reel on the main profile grid too.

export async function instagramPostReel(
  creds: InstagramCredentials,
  caption: string,
  videoUrl: string,
  opts?: { shareToFeed?: boolean; coverUrl?: string },
): Promise<InstagramPostResult> {
  if (!videoUrl) throw new Error("Instagram Reel requires a public video URL.");
  // Step 1: create the REELS container.
  const containerParams = new URLSearchParams({
    media_type: "REELS",
    video_url: videoUrl,
    caption,
    access_token: creds.accessToken,
  });
  if (opts?.shareToFeed !== undefined) {
    containerParams.set("share_to_feed", String(opts.shareToFeed));
  }
  if (opts?.coverUrl) containerParams.set("cover_url", opts.coverUrl);

  const cRes = await fetch(`${GRAPH}/${creds.igUserId}/media?${containerParams}`, { method: "POST" });
  if (!cRes.ok) throw new Error(`IG reel container failed (${cRes.status}): ${await cRes.text()}`);
  const { id: containerId } = (await cRes.json()) as { id: string };

  // Step 2: poll to FINISHED. Reels transcode takes longer than images.
  await pollContainerStatus(containerId, creds.accessToken, {
    initialDelayMs: 5000,
    intervalMs: 8000,
    timeoutMs: 5 * 60 * 1000,
  });

  // Step 3: publish.
  return publishContainer(creds, containerId);
}

// Shared publish step.
async function publishContainer(
  creds: InstagramCredentials,
  containerId: string,
): Promise<InstagramPostResult> {
  const pRes = await fetch(
    `${GRAPH}/${creds.igUserId}/media_publish?creation_id=${containerId}&access_token=${encodeURIComponent(creds.accessToken)}`,
    { method: "POST" },
  );
  if (!pRes.ok) throw new Error(`IG publish failed (${pRes.status}): ${await pRes.text()}`);
  const pub = (await pRes.json()) as { id: string };
  return { id: pub.id };
}

// Poll an IG media container's status_code to a terminal state. Returns on
// FINISHED, throws on ERROR/EXPIRED, and throws RetryableError when the time
// budget is exhausted so the cron leaves the post `scheduled` and retries next
// tick rather than failing a transcode still in progress. Publishing before
// FINISHED yields HTTP 400, so we never publish from here.
//
// Hardening path (NOT built now): persist the container id on the post row and
// resume polling + publish on a later tick instead of re-creating the container.
async function pollContainerStatus(
  containerId: string,
  token: string,
  opts: { initialDelayMs: number; intervalMs: number; timeoutMs: number },
): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  if (opts.initialDelayMs > 0) {
    await new Promise((r) => setTimeout(r, opts.initialDelayMs));
  }
  for (;;) {
    const res = await fetch(
      `${GRAPH}/${containerId}?fields=status_code&access_token=${encodeURIComponent(token)}`,
    );
    if (!res.ok) {
      throw new Error(`IG container status failed (${res.status}): ${await res.text()}`);
    }
    const json = (await res.json()) as { status_code?: string };
    const state = json.status_code;
    if (state === "FINISHED") return;
    if (state === "ERROR" || state === "EXPIRED") {
      throw new Error(`Instagram media processing failed (status_code=${state}).`);
    }
    // IN_PROGRESS (or PUBLISHED, unexpected pre-publish) → keep polling.
    if (Date.now() + opts.intervalMs >= deadline) {
      throw new RetryableError(
        `Instagram container ${containerId} still processing after ${Math.round(
          opts.timeoutMs / 1000,
        )}s; will retry next tick.`,
      );
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
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
