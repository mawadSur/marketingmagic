// Facebook Page publishing via the Meta Graph API.
//
// OAuth: Facebook Login + "Manage Pages" use case on the umbrella Meta app.
// Scopes needed: pages_show_list, pages_manage_posts, pages_read_engagement.
// Posting itself goes against /{page-id}/feed with the *Page* access token
// (NOT the user token Meta hands back at the token exchange — we fetch the
// page tokens from /me/accounts after auth).
//
// Page picker: Meta returns every Page the user manages. For now we pick
// the first one automatically and store it on social_accounts. A future
// enhancement would expose a /settings/channels/facebook/select-target
// picker (mirror of the LinkedIn org picker) when the user manages
// multiple Pages.

import { serverEnv } from "@/lib/env";

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

export async function facebookExchangeCode(opts: {
  code: string;
  redirectUri: string;
}): Promise<{ pageId: string; pageName: string; pageAccessToken: string; expiresAt: string }> {
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

  // 3. List pages → grab the first one's Page access token. Page tokens
  //    derived from a long-lived user token are themselves long-lived
  //    (effectively non-expiring as long as the user keeps the app
  //    authorized).
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

  // First-with-publish-permission wins. Users with multiple Pages will
  // need the future picker UI to switch.
  const publishable = pages.data.find((p) => !p.tasks || p.tasks.includes("CREATE_CONTENT")) ?? pages.data[0]!;

  // Record exchange time so we have a reference point even though Page
  // tokens themselves don't expire on a fixed schedule.
  return {
    pageId: publishable.id,
    pageName: publishable.name,
    pageAccessToken: publishable.access_token,
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
