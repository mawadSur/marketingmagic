// Instagram via Meta Graph API (Business/Creator account linked to FB Page).
//
// Two-step publish: create container with image_url, then publish.
// Auth: long-lived page access token with `instagram_basic`,
// `instagram_content_publish`, `pages_show_list`.

import { serverEnv } from "@/lib/env";

export interface InstagramCredentials {
  accessToken: string;
  expiresAt: string;
  igUserId: string; // numeric IG Business user id
}

const GRAPH = "https://graph.facebook.com/v23.0";

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
  if (!env.META_APP_ID) throw new Error("META_APP_ID is not set.");
  const params = new URLSearchParams({
    client_id: env.META_APP_ID,
    redirect_uri: opts.redirectUri,
    scope: "instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement",
    response_type: "code",
    state: opts.state,
  });
  return `https://www.facebook.com/v23.0/dialog/oauth?${params}`;
}

export async function instagramExchangeCode(opts: {
  code: string;
  redirectUri: string;
}): Promise<{ accessToken: string; igUserId: string; expiresAt: string }> {
  const env = serverEnv();
  if (!env.META_APP_ID || !env.META_APP_SECRET) throw new Error("META OAuth keys are not set.");

  // 1. Authorization-code → short-lived user token.
  const tokenRes = await fetch(
    `${GRAPH}/oauth/access_token?` +
      new URLSearchParams({
        client_id: env.META_APP_ID,
        redirect_uri: opts.redirectUri,
        client_secret: env.META_APP_SECRET,
        code: opts.code,
      }),
  );
  if (!tokenRes.ok) throw new Error(`IG token failed (${tokenRes.status}): ${await tokenRes.text()}`);
  const tok = (await tokenRes.json()) as { access_token: string; expires_in?: number };

  // 2. Find the user's pages → which page has an IG Business account.
  const pagesRes = await fetch(`${GRAPH}/me/accounts?access_token=${encodeURIComponent(tok.access_token)}`);
  if (!pagesRes.ok) throw new Error(`IG pages failed (${pagesRes.status}): ${await pagesRes.text()}`);
  const pages = (await pagesRes.json()) as {
    data: Array<{ id: string; access_token: string; name: string }>;
  };
  if (!pages.data?.length) throw new Error("No FB pages found on this account.");

  // Pick the first page with a connected IG Business account.
  for (const page of pages.data) {
    const igRes = await fetch(
      `${GRAPH}/${page.id}?fields=instagram_business_account&access_token=${encodeURIComponent(page.access_token)}`,
    );
    if (!igRes.ok) continue;
    const ig = (await igRes.json()) as { instagram_business_account?: { id: string } };
    if (ig.instagram_business_account?.id) {
      return {
        accessToken: page.access_token,
        igUserId: ig.instagram_business_account.id,
        expiresAt: new Date(Date.now() + (tok.expires_in ?? 60 * 60 * 24 * 60) * 1000).toISOString(),
      };
    }
  }
  throw new Error("No Instagram Business account linked to any of your Pages.");
}

export async function instagramVerify(accessToken: string, igUserId: string): Promise<{ username: string }> {
  const res = await fetch(`${GRAPH}/${igUserId}?fields=username&access_token=${encodeURIComponent(accessToken)}`);
  if (!res.ok) throw new Error(`IG verify failed (${res.status}): ${await res.text()}`);
  const json = (await res.json()) as { username: string };
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
