// Twitter / X OAuth 1.0a posting client. Lifted from pitch-pit and trimmed.
//
// Per-workspace credentials live in social_accounts.credentials and have shape:
//   { apiKey, apiSecret, accessToken, accessTokenSecret }
//
// Posting goes through POST /2/tweets with OAuth 1.0a user-context.
// Verify uses GET /2/users/me with the same auth.

import OAuth from "oauth-1.0a";
import crypto from "node:crypto";

export interface XCredentials {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

// Extra metadata we tag onto credentials JSONB to distinguish manual-paste
// from OAuth-issued tokens. Optional — older rows omit it. Used by the
// settings UI to decide whether to surface a "re-authorize via OAuth" banner.
export type XConnectionMethod = "oauth" | "manual";

export interface XPostResult {
  id: string;
  text: string;
}

const BASE_URL = "https://api.twitter.com";

function client(creds: XCredentials) {
  return new OAuth({
    consumer: { key: creds.apiKey, secret: creds.apiSecret },
    signature_method: "HMAC-SHA1",
    hash_function(base, key) {
      return crypto.createHmac("sha1", key).update(base).digest("base64");
    },
  });
}

function authorize(creds: XCredentials, url: string, method: "GET" | "POST") {
  const oauth = client(creds);
  return oauth.toHeader(
    oauth.authorize({ url, method }, { key: creds.accessToken, secret: creds.accessTokenSecret }),
  );
}

export async function xVerify(creds: XCredentials): Promise<{ id: string; username: string }> {
  const url = `${BASE_URL}/2/users/me`;
  const auth = authorize(creds, url, "GET");
  const res = await fetch(url, { headers: { ...auth } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`X verify failed (${res.status}): ${text}`);
  }
  const body = (await res.json()) as { data: { id: string; username: string } };
  return { id: body.data.id, username: body.data.username };
}

export async function xPost(
  creds: XCredentials,
  text: string,
  mediaIds?: string[],
  inReplyToTweetId?: string,
): Promise<XPostResult> {
  const url = `${BASE_URL}/2/tweets`;
  const auth = authorize(creds, url, "POST");
  const body: {
    text: string;
    media?: { media_ids: string[] };
    reply?: { in_reply_to_tweet_id: string };
  } = { text };
  if (mediaIds && mediaIds.length > 0) {
    body.media = { media_ids: mediaIds };
  }
  if (inReplyToTweetId) {
    body.reply = { in_reply_to_tweet_id: inReplyToTweetId };
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { data?: XPostResult; errors?: unknown };
  if (!res.ok || !json.data) {
    throw new Error(`X post failed (${res.status}): ${JSON.stringify(json)}`);
  }
  return json.data;
}

// ─── Phase 6.8 — sequential thread posting ─────────────────────────────────
//
// `xPostThread` posts a thread by chaining `in_reply_to_tweet_id` on each
// subsequent tweet. Sequential with a 1.2s delay between tweets so we
// don't trip per-second rate caps, and so that the previous tweet has
// time to settle before the next one references it.
//
// Partial-failure shape: on first failure, we return the tweet IDs we
// did manage to post + a `lastError` describing the failing tweet index
// (0-based). The caller is responsible for persisting partial state
// (per-tweet `external_id`) and surfacing a retry affordance.
//
// `startInReplyTo` lets the caller resume a partially-published thread:
// pass the last successfully-posted tweet id + slice `tweets[]` to the
// unpublished tail. Idempotency itself sits one level up in the cron
// (social_posts_ledger keyed by `post:<tweet-row-id>`).
export interface XPostThreadResult {
  tweetIds: string[]; // newly-posted tweet IDs in order
  lastError?: { tweetIndex: number; error: string };
}

export async function xPostThread(
  creds: XCredentials,
  tweets: string[],
  opts: { startInReplyTo?: string; delayMs?: number } = {},
): Promise<XPostThreadResult> {
  if (tweets.length === 0) {
    throw new Error("xPostThread called with no tweets");
  }
  const delayMs = Math.max(800, Math.min(opts.delayMs ?? 1200, 5000));
  const tweetIds: string[] = [];
  let inReplyTo = opts.startInReplyTo;

  for (let i = 0; i < tweets.length; i++) {
    const text = tweets[i];
    try {
      const sent = await xPost(creds, text, undefined, inReplyTo);
      tweetIds.push(sent.id);
      inReplyTo = sent.id;
    } catch (err) {
      return {
        tweetIds,
        lastError: {
          tweetIndex: i,
          error: err instanceof Error ? err.message : String(err),
        },
      };
    }
    // Inter-tweet delay — skip after the last tweet.
    if (i < tweets.length - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return { tweetIds };
}

// Single-shot media upload via v1.1 (v2 still has no media-upload endpoint as
// of 2025/2026). For files ≤5MB we can use the simple form-encoded path.
// Anything larger would need INIT/APPEND/FINALIZE — out of scope for stills.
const UPLOAD_URL = "https://upload.twitter.com/1.1/media/upload.json";

export async function xUploadMedia(
  creds: XCredentials,
  bytes: Uint8Array,
  contentType: string,
): Promise<{ media_id_string: string }> {
  if (bytes.byteLength > 5 * 1024 * 1024) {
    throw new Error("Media >5MB requires chunked upload (not implemented).");
  }
  // OAuth 1.0a signs the URL; the body is multipart/form-data with a single
  // `media` field. We don't include the body in the signature base string —
  // standard for media upload.
  const auth = authorize(creds, UPLOAD_URL, "POST");
  const form = new FormData();
  form.append("media", new Blob([bytes as BlobPart], { type: contentType }));

  const res = await fetch(UPLOAD_URL, {
    method: "POST",
    headers: { ...auth },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`X media upload failed (${res.status}): ${text.slice(0, 400)}`);
  }
  const json = (await res.json()) as { media_id_string?: string };
  if (!json.media_id_string) {
    throw new Error("X media upload returned no media_id_string.");
  }
  return { media_id_string: json.media_id_string };
}

// V1 — metrics pull. Tweet lookup with public + non-public metrics.
// Non-public metrics (impressions, url_link_clicks) require user-context auth.
export interface XTweetMetrics {
  impressions: number;
  likes: number;
  reposts: number;
  replies: number;
  clicks: number;
}

export async function xMetrics(creds: XCredentials, tweetId: string): Promise<XTweetMetrics> {
  const params = new URLSearchParams({
    "tweet.fields": "public_metrics,non_public_metrics,organic_metrics",
  });
  const url = `${BASE_URL}/2/tweets/${tweetId}?${params}`;
  const auth = authorize(creds, url, "GET");
  const res = await fetch(url, { headers: { ...auth } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`X metrics failed (${res.status}): ${text}`);
  }
  const json = (await res.json()) as {
    data?: {
      public_metrics?: {
        like_count?: number;
        retweet_count?: number;
        reply_count?: number;
        impression_count?: number;
      };
      non_public_metrics?: { impression_count?: number; url_link_clicks?: number };
      organic_metrics?: { impression_count?: number; url_link_clicks?: number };
    };
  };
  const d = json.data ?? {};
  const impressions =
    d.organic_metrics?.impression_count ??
    d.non_public_metrics?.impression_count ??
    d.public_metrics?.impression_count ??
    0;
  const clicks = d.organic_metrics?.url_link_clicks ?? d.non_public_metrics?.url_link_clicks ?? 0;
  return {
    impressions,
    clicks,
    likes: d.public_metrics?.like_count ?? 0,
    reposts: d.public_metrics?.retweet_count ?? 0,
    replies: d.public_metrics?.reply_count ?? 0,
  };
}

// ─── 3-legged OAuth 1.0a (V3 self-serve) ────────────────────────────────────
//
// Flow:
//   1. POST /oauth/request_token — app-only signed, returns request token.
//   2. Redirect user to /oauth/authorize?oauth_token=<token>.
//   3. Twitter redirects back with oauth_token + oauth_verifier.
//   4. POST /oauth/access_token — exchanges verifier for permanent user token.
//
// The consumer (app-level) key/secret come from env (X_CLIENT_ID/SECRET).
// The user-level access_token/access_token_secret are persisted per workspace.

const REQUEST_TOKEN_URL = "https://api.twitter.com/oauth/request_token";
const AUTHORIZE_URL = "https://api.twitter.com/oauth/authorize";
const ACCESS_TOKEN_URL = "https://api.twitter.com/oauth/access_token";

function appClient(apiKey: string, apiSecret: string) {
  return new OAuth({
    consumer: { key: apiKey, secret: apiSecret },
    signature_method: "HMAC-SHA1",
    hash_function(base, key) {
      return crypto.createHmac("sha1", key).update(base).digest("base64");
    },
  });
}

// Parse Twitter's `application/x-www-form-urlencoded` OAuth response bodies.
// Throws when the response is missing required fields — callers translate
// to user-facing errors at the route boundary.
function parseOAuthBody(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of body.split("&")) {
    if (!pair) continue;
    const [k, v] = pair.split("=");
    if (k) out[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
  }
  return out;
}

export interface XRequestTokenResult {
  oauth_token: string;
  oauth_token_secret: string;
  oauth_callback_confirmed: boolean;
}

// Step 1: ask Twitter for a request token. Twitter signs the response with the
// app credentials only — no user token yet. The returned oauth_token doubles
// as the lookup key once Twitter redirects back; oauth_token_secret must be
// stashed server-side until then.
export async function xRequestToken(opts: {
  apiKey: string;
  apiSecret: string;
  callbackUrl: string;
}): Promise<XRequestTokenResult> {
  const oauth = appClient(opts.apiKey, opts.apiSecret);
  const reqData = {
    url: REQUEST_TOKEN_URL,
    method: "POST",
    data: { oauth_callback: opts.callbackUrl },
  };
  // Pass empty token — request_token is app-only signed.
  const header = oauth.toHeader(oauth.authorize(reqData));
  const res = await fetch(REQUEST_TOKEN_URL, {
    method: "POST",
    headers: {
      ...header,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ oauth_callback: opts.callbackUrl }).toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`X request_token failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const parsed = parseOAuthBody(await res.text());
  if (!parsed.oauth_token || !parsed.oauth_token_secret) {
    throw new Error("X request_token response missing oauth_token / oauth_token_secret.");
  }
  return {
    oauth_token: parsed.oauth_token,
    oauth_token_secret: parsed.oauth_token_secret,
    oauth_callback_confirmed: parsed.oauth_callback_confirmed === "true",
  };
}

// Step 2: produce the URL we redirect the user to. Twitter prompts them to
// approve; on approval, Twitter redirects back to our callback with
// oauth_token + oauth_verifier on the query string.
export function xAuthorizeUrl(oauthToken: string): string {
  const params = new URLSearchParams({ oauth_token: oauthToken });
  return `${AUTHORIZE_URL}?${params}`;
}

export interface XAccessTokenResult {
  oauth_token: string; // user-scoped access token
  oauth_token_secret: string;
  user_id: string;
  screen_name: string;
}

// Step 4: exchange verifier for permanent user token. We sign with the
// app credentials *and* the request-token pair so Twitter can match the
// callback to its original /authorize prompt.
export async function xAccessToken(opts: {
  apiKey: string;
  apiSecret: string;
  requestToken: string;
  requestTokenSecret: string;
  verifier: string;
}): Promise<XAccessTokenResult> {
  const oauth = appClient(opts.apiKey, opts.apiSecret);
  const reqData = {
    url: ACCESS_TOKEN_URL,
    method: "POST",
    data: { oauth_verifier: opts.verifier },
  };
  const header = oauth.toHeader(
    oauth.authorize(reqData, { key: opts.requestToken, secret: opts.requestTokenSecret }),
  );
  const res = await fetch(ACCESS_TOKEN_URL, {
    method: "POST",
    headers: {
      ...header,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ oauth_verifier: opts.verifier }).toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`X access_token failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const parsed = parseOAuthBody(await res.text());
  if (!parsed.oauth_token || !parsed.oauth_token_secret) {
    throw new Error("X access_token response missing oauth_token / oauth_token_secret.");
  }
  return {
    oauth_token: parsed.oauth_token,
    oauth_token_secret: parsed.oauth_token_secret,
    user_id: parsed.user_id ?? "",
    screen_name: parsed.screen_name ?? "",
  };
}

// ─── Phase 6.6 (Competitor Watch) ───────────────────────────────────────
//
// Uses GET /2/users/by/username/:username to resolve a screen name to an
// id, then GET /2/users/:id/tweets for the timeline. Both require the
// elevated tier; for free-tier credentials this returns 403 and the
// competitor-watch cron flags the row failed.
//
// Bound results to `count` (max 100 per API docs). The competitor cron
// uses 30 for daily polling and 100 for initial backfill.

export interface XPublicTweet {
  id: string;
  text: string;
  created_at: string;
  public_metrics?: {
    like_count?: number;
    retweet_count?: number;
    reply_count?: number;
    impression_count?: number;
  };
}

export async function xResolveUsername(
  creds: XCredentials,
  username: string,
): Promise<{ id: string; username: string; name: string | null }> {
  const cleaned = username.replace(/^@/, "").trim();
  const url = `${BASE_URL}/2/users/by/username/${encodeURIComponent(cleaned)}`;
  const auth = authorize(creds, url, "GET");
  const res = await fetch(url, { headers: { ...auth } });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`X resolve username failed (${res.status}): ${text.slice(0, 200)}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  const body = (await res.json()) as { data?: { id: string; username: string; name?: string } };
  if (!body.data?.id) {
    throw new Error(`X resolve username returned no data for @${cleaned}`);
  }
  return { id: body.data.id, username: body.data.username, name: body.data.name ?? null };
}

export async function xGetUserPosts(
  creds: XCredentials,
  userId: string,
  count = 30,
): Promise<XPublicTweet[]> {
  const bounded = Math.max(5, Math.min(100, Math.floor(count)));
  const params = new URLSearchParams({
    max_results: String(bounded),
    "tweet.fields": "created_at,public_metrics",
    exclude: "retweets,replies",
  });
  const url = `${BASE_URL}/2/users/${encodeURIComponent(userId)}/tweets?${params}`;
  const auth = authorize(creds, url, "GET");
  const res = await fetch(url, { headers: { ...auth } });
  if (!res.ok) {
    const text = await res.text();
    // Surface rate-limit + 403 distinctly so the caller can downgrade
    // the watch row's status without retrying immediately.
    const err = new Error(`X get user tweets failed (${res.status}): ${text.slice(0, 200)}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  const body = (await res.json()) as { data?: XPublicTweet[] };
  return body.data ?? [];
}
