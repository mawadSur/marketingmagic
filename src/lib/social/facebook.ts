// Facebook Page publishing via the Meta Graph API.
//
// OAuth: Facebook Login + "Manage Pages" use case on the umbrella Meta app.
// Scopes needed: pages_show_list, pages_manage_posts, pages_read_engagement.
// Posting itself goes against /{page-id}/feed with the *Page* access token
// (NOT the user token Meta hands back at the token exchange — we fetch the
// page tokens from /me/accounts after auth).
//
// Page picker: Meta returns every Page the user manages. When the operator
// manages more than one publishable Page we surface a
// /settings/channels/facebook/select-target picker (mirror of the LinkedIn
// org picker) so they choose which Page maps to the active (client)
// workspace. When they manage exactly one, we finalize it automatically —
// no extra click. The chosen Page's *Page access token* is what we persist
// on social_accounts; the user token is only ever used transiently to list
// Pages and is never stored once a Page is finalized.

import { serverEnv } from "@/lib/env";
import { RetryableError } from "./errors";

export interface FacebookCredentials {
  pageId: string;
  pageAccessToken: string; // long-lived Page access token
  expiresAt: string; // ISO; Page tokens are effectively non-expiring but we record the exchange time
}

const GRAPH = "https://graph.facebook.com/v23.0";

export interface FacebookPostResult {
  id: string; // composite id "{page-id}_{post-id}"
}

export interface FacebookMetrics {
  reach: number;
  impressions: number;
  reactions: number;
  comments: number;
  shares: number;
}

// ─── OAuth ─────────────────────────────────────────────────────────────────

export function facebookAuthorizeUrl(opts: { redirectUri: string; state: string }): string {
  const env = serverEnv();
  if (!env.META_APP_ID) throw new Error("META_APP_ID is not set.");
  if (!env.META_FB_LOGIN_CONFIG_ID) {
    throw new Error(
      "META_FB_LOGIN_CONFIG_ID is not set. The Meta app uses Facebook Login for Business, which binds permissions/assets to a Configuration ID instead of the OAuth scope param.",
    );
  }
  // Facebook Login for Business: permissions + asset types come from the
  // Configuration in the dashboard, NOT from a scope= param. Sending scope=
  // here while the app has FLB (not classic Facebook Login) causes FB's
  // Comet dialog to crash with the generic "Something Went Wrong" page.
  const params = new URLSearchParams({
    client_id: env.META_APP_ID,
    redirect_uri: opts.redirectUri,
    config_id: env.META_FB_LOGIN_CONFIG_ID,
    response_type: "code",
    state: opts.state,
  });
  return `https://www.facebook.com/v23.0/dialog/oauth?${params}`;
}

// A Page the operator manages, with the Page-scoped access token we'd persist
// if they choose it. `pageAccessToken` is a secret — never put it in a URL or
// any client-visible surface; it lives only in server memory / the transient
// httpOnly picker cookie (FB_PAGE_PICKER_COOKIE) until a single Page is
// finalized into social_accounts.
export interface FacebookPageCandidate {
  pageId: string;
  pageName: string;
  pageAccessToken: string;
}

// Result of the OAuth exchange: every publishable Page the operator manages.
// The callback decides whether to auto-finalize (exactly one) or route to the
// picker (more than one).
export interface FacebookExchangeResult {
  pages: FacebookPageCandidate[];
  // Reference exchange time. Page tokens don't expire on a fixed schedule, but
  // we record this so finalized credentials carry an `expiresAt` like the
  // other channels.
  expiresAt: string;
}

// Transient stash for the multi-Page picker. Serialized to a short-lived,
// httpOnly cookie by the OAuth callback and consumed by the select-target pick
// action. Bound to one workspace so the picker can't be replayed against a
// different workspace, and carries the same `expiresAt` the finalized
// credentials will use. Page tokens here are secrets — the cookie is httpOnly
// and dropped the moment a Page is finalized.
export const FB_PAGE_PICKER_COOKIE = "fb_page_picker";

export interface FacebookPickerStash {
  workspaceId: string;
  expiresAt: string;
  pages: FacebookPageCandidate[];
}

export async function facebookExchangeCode(opts: {
  code: string;
  redirectUri: string;
}): Promise<FacebookExchangeResult> {
  const env = serverEnv();
  if (!env.META_APP_ID || !env.META_APP_SECRET) {
    throw new Error("META OAuth keys are not set.");
  }

  // 1. Code → short-lived user token.
  const tokenRes = await fetch(
    `${GRAPH}/oauth/access_token?` +
      new URLSearchParams({
        client_id: env.META_APP_ID,
        client_secret: env.META_APP_SECRET,
        redirect_uri: opts.redirectUri,
        code: opts.code,
      }),
  );
  if (!tokenRes.ok) {
    throw new Error(`Facebook token failed (${tokenRes.status}): ${await tokenRes.text()}`);
  }
  const tok = (await tokenRes.json()) as { access_token: string; expires_in?: number };

  // 2. Short-lived → long-lived user token (60 days).
  const longRes = await fetch(
    `${GRAPH}/oauth/access_token?` +
      new URLSearchParams({
        grant_type: "fb_exchange_token",
        client_id: env.META_APP_ID,
        client_secret: env.META_APP_SECRET,
        fb_exchange_token: tok.access_token,
      }),
  );
  if (!longRes.ok) {
    throw new Error(`Facebook long token failed (${longRes.status}): ${await longRes.text()}`);
  }
  const long = (await longRes.json()) as { access_token: string; expires_in?: number };

  // 3. List the Pages this user manages. Each row carries its own Page access
  //    token derived from the long-lived user token (itself long-lived as long
  //    as the app stays authorized). We keep ALL publishable Pages so the
  //    callback can offer a picker; we never auto-discard the operator's other
  //    Pages here.
  const pagesRes = await fetch(
    `${GRAPH}/me/accounts?access_token=${encodeURIComponent(long.access_token)}`,
  );
  if (!pagesRes.ok) {
    throw new Error(`Facebook pages failed (${pagesRes.status}): ${await pagesRes.text()}`);
  }
  const pages = (await pagesRes.json()) as {
    data: Array<{ id: string; name: string; access_token: string; tasks?: string[] }>;
  };
  if (!pages.data?.length) {
    throw new Error("No Facebook Pages found on this account. Create a Page first or re-authorize.");
  }

  // Keep only Pages the operator can publish to. Meta omits `tasks` on some
  // shapes — treat missing tasks as publishable (old behavior) rather than
  // silently dropping the Page.
  const publishable = pages.data.filter((p) => !p.tasks || p.tasks.includes("CREATE_CONTENT"));
  const candidates = (publishable.length ? publishable : pages.data).map((p) => ({
    pageId: p.id,
    pageName: p.name,
    pageAccessToken: p.access_token,
  }));

  return {
    pages: candidates,
    expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

export async function facebookVerify(
  pageId: string,
  pageAccessToken: string,
): Promise<{ name: string }> {
  const res = await fetch(
    `${GRAPH}/${pageId}?fields=name&access_token=${encodeURIComponent(pageAccessToken)}`,
  );
  if (!res.ok) throw new Error(`Facebook verify failed (${res.status}): ${await res.text()}`);
  const json = (await res.json()) as { name: string };
  return { name: json.name };
}

// ─── Posting ───────────────────────────────────────────────────────────────

export async function facebookPost(
  creds: FacebookCredentials,
  message: string,
  linkUrl?: string,
): Promise<FacebookPostResult> {
  // FB Page feed accepts plain text via `message`. Including `link` makes
  // Meta unfurl the URL into a preview card. For image-only or video
  // posts we'd hit /{page-id}/photos or /{page-id}/videos respectively —
  // out of scope for the v1 scaffold.
  const body = new URLSearchParams({
    message,
    access_token: creds.pageAccessToken,
  });
  if (linkUrl) body.set("link", linkUrl);

  const res = await fetch(`${GRAPH}/${creds.pageId}/feed`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Facebook post failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { id: string };
  return { id: json.id };
}

// ─── Video (feed) ────────────────────────────────────────────────────────────
//
// Facebook ingests video by URL-pull: we hand it the public Storage URL and
// Meta downloads + transcodes asynchronously on its side. Unlike /feed (which
// returns a composite "{page-id}_{post-id}"), /videos returns the BARE video
// id; we poll that id's processing status to a terminal state before reporting
// success. This is a FEED video, not a Reel — Reels use a separate
// /video_reels upload-session flow we don't need here.

// Total wall-clock budget for transcode polling. The cron's maxDuration is the
// hard ceiling; we stop comfortably under it and let the next tick retry (the
// post stays `scheduled`) rather than risk the function being killed mid-write.
const FB_VIDEO_POLL_TIMEOUT_MS = 4 * 60 * 1000; // ~4 min
const FB_VIDEO_POLL_INTERVAL_MS = 4000; // ~4s between status checks

export async function facebookPostVideo(
  creds: FacebookCredentials,
  caption: string,
  fileUrl: string,
): Promise<{ id: string }> {
  if (!fileUrl) throw new Error("Facebook video post requires a public file URL.");
  const body = new URLSearchParams({
    file_url: fileUrl,
    description: caption,
    access_token: creds.pageAccessToken,
  });
  const res = await fetch(`${GRAPH}/${creds.pageId}/videos`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Facebook video upload failed (${res.status}): ${await res.text()}`);
  }
  // /videos returns the bare VIDEO_ID (not the {page}_{post} composite).
  const { id: videoId } = (await res.json()) as { id: string };
  if (!videoId) throw new Error("Facebook video upload returned no video id.");

  await pollVideoStatus(videoId, creds.pageAccessToken);
  return { id: videoId };
}

// Poll a video's async processing status until it's `ready`. Throws on Meta's
// `error` terminal state; throws a RetryableError if we exhaust the time budget
// so the cron leaves the post `scheduled` and retries on the next tick rather
// than marking it permanently failed for a transcode that may still finish.
//
// Hardening path (NOT built now): persist the VIDEO_ID as a transcode handle on
// the post row at upload time, and on a later tick resume from `pollVideoStatus`
// instead of re-uploading. That makes a single slow transcode survive across
// many cron ticks with zero duplicate uploads.
async function pollVideoStatus(videoId: string, token: string): Promise<void> {
  const deadline = Date.now() + FB_VIDEO_POLL_TIMEOUT_MS;
  for (;;) {
    const res = await fetch(
      `${GRAPH}/${videoId}?fields=status&access_token=${encodeURIComponent(token)}`,
    );
    if (!res.ok) {
      throw new Error(`Facebook video status failed (${res.status}): ${await res.text()}`);
    }
    const json = (await res.json()) as {
      status?: { video_status?: string; processing_progress?: number };
    };
    const state = json.status?.video_status;
    if (state === "ready") return;
    if (state === "error") {
      throw new Error("Facebook video processing failed (status=error).");
    }
    // `processing` (or an unrecognised transient state) → keep polling.
    if (Date.now() + FB_VIDEO_POLL_INTERVAL_MS >= deadline) {
      throw new RetryableError(
        `Facebook video ${videoId} still processing after ${Math.round(
          FB_VIDEO_POLL_TIMEOUT_MS / 1000,
        )}s; will retry next tick.`,
      );
    }
    await new Promise((r) => setTimeout(r, FB_VIDEO_POLL_INTERVAL_MS));
  }
}

// ─── Metrics ───────────────────────────────────────────────────────────────

export async function facebookMetrics(
  creds: FacebookCredentials,
  postId: string,
): Promise<FacebookMetrics> {
  const metrics = "post_impressions,post_impressions_unique,post_reactions_by_type_total,post_clicks";
  const res = await fetch(
    `${GRAPH}/${postId}/insights?metric=${metrics}&access_token=${encodeURIComponent(creds.pageAccessToken)}`,
  );
  if (!res.ok) {
    // Metrics endpoint commonly fails for posts that haven't had enough
    // engagement to surface insights yet. Don't break the cron pull — return
    // zeros and let the next run try again.
    return { reach: 0, impressions: 0, reactions: 0, comments: 0, shares: 0 };
  }
  const json = (await res.json()) as {
    data: Array<{ name: string; values: Array<{ value: number | Record<string, number> }> }>;
  };
  const map = new Map<string, number>();
  for (const m of json.data ?? []) {
    const v = m.values?.[0]?.value;
    if (typeof v === "number") map.set(m.name, v);
    else if (v && typeof v === "object") {
      // post_reactions_by_type_total returns { like: N, love: N, ... } — sum.
      map.set(m.name, Object.values(v).reduce((a, b) => a + (b ?? 0), 0));
    }
  }

  // Comments + shares need a separate /comments and field-summary call;
  // include them with a graph query for accuracy.
  const sumRes = await fetch(
    `${GRAPH}/${postId}?fields=comments.summary(true),shares&access_token=${encodeURIComponent(creds.pageAccessToken)}`,
  );
  let comments = 0;
  let shares = 0;
  if (sumRes.ok) {
    const sum = (await sumRes.json()) as {
      comments?: { summary?: { total_count?: number } };
      shares?: { count?: number };
    };
    comments = sum.comments?.summary?.total_count ?? 0;
    shares = sum.shares?.count ?? 0;
  }

  return {
    impressions: map.get("post_impressions") ?? 0,
    reach: map.get("post_impressions_unique") ?? 0,
    reactions: map.get("post_reactions_by_type_total") ?? 0,
    comments,
    shares,
  };
}
