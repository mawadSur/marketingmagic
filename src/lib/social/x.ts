// Twitter / X OAuth 2.0 PKCE posting client.
//
// Migrated from OAuth 1.0a in commit (this PR) because X Free tier silently
// rejects /oauth/authorize for OAuth 1.0a apps — `request_token` succeeds but
// the user-facing authorize page redirects to /login/error?redirect_after_login=/.
// OAuth 2.0 PKCE works on Free tier and uses simpler `Authorization: Bearer
// <token>` headers in place of HMAC-SHA1 request signing.
//
// Per-workspace credentials live in social_accounts.credentials and have shape:
//   { accessToken, refreshToken, expiresAt }
//
// Access tokens expire in ~2 hours; refresh tokens are long-lived. Callers
// should hit `loadFreshXCredentials` before any API call so an expired token
// gets transparently refreshed and persisted back. The dispatcher does this.

import OAuth from "oauth-1.0a";
import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { serverEnv } from "@/lib/env";

// Primary credential shape: OAuth 2.0 PKCE-issued tokens.
export interface XCredentials {
  // OAuth 2.0 user-context Bearer token. Expires in ~7200 seconds (2 hours).
  accessToken: string;
  // OAuth 2.0 refresh token. Long-lived; rotates on each refresh if X chooses.
  refreshToken: string;
  // Absolute expiry in unix ms (Date.now() + expires_in*1000 at issue time).
  // We refresh proactively when within 5 minutes of expiry.
  expiresAt: number;
}

// Legacy credential shape: OAuth 1.0a Consumer Keys + Access Token (and
// Secret) pair. The user generates both pairs manually in the X dev portal
// and pastes them via the "Advanced" form on the Connect X page. We keep
// this path because (a) OAuth 2.0 PKCE consent flow can fail on
// misconfigured apps, and (b) some users want to use a dedicated X
// developer account with permanent tokens rather than running through OAuth.
//
// OAuth 1.0a tokens don't expire, so loadFreshXCredentials is a no-op for
// these — the only "refresh" happens when the user manually pastes new
// tokens after X rotates them.
export interface XCredentialsLegacy {
  apiKey: string; // OAuth 1.0a Consumer Key
  apiSecret: string; // OAuth 1.0a Consumer Secret
  accessToken: string;
  accessTokenSecret: string;
}

// Union type used by every API method. The discriminator below decides
// which auth scheme to use at call time.
export type XCredentialsAny = XCredentials | XCredentialsLegacy;

export function isLegacyXCreds(creds: XCredentialsAny): creds is XCredentialsLegacy {
  return (
    typeof (creds as XCredentialsLegacy).apiKey === "string" &&
    typeof (creds as XCredentialsLegacy).accessTokenSecret === "string"
  );
}

export interface XPostResult {
  id: string;
  text: string;
}

const BASE_URL = "https://api.twitter.com";

// ─── OAuth 2.0 PKCE primitives ──────────────────────────────────────────────
//
// Flow:
//   1. /api/oauth/x/initiate generates a code_verifier (random) + code_challenge
//      (SHA256(verifier), base64url), redirects to /i/oauth2/authorize.
//   2. X redirects back with ?code=... &state=... — callback exchanges the
//      code + original verifier at /2/oauth2/token for an access_token +
//      refresh_token pair.
//   3. Subsequent API calls send `Authorization: Bearer <access_token>`.
//   4. Before any API call, loadFreshXCredentials checks expiry and refreshes
//      via /2/oauth2/token if needed.

const AUTHORIZE_URL = "https://twitter.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.twitter.com/2/oauth2/token";

// Default scopes we ask for. tweet.write enables posting; offline.access is
// required for X to issue a refresh_token (without it, the access token
// expires in 2h with no way to renew). users.read powers /2/users/me for
// handle resolution.
//
// If you add a feature that needs additional scopes (e.g. tweet.read for
// metrics, like.write for engagement), append here AND have users re-auth.
export const X_OAUTH_SCOPES = [
  "tweet.read",
  "tweet.write",
  "users.read",
  "offline.access",
] as const;

// Build a PKCE pair. The verifier is a high-entropy random string; the
// challenge is its SHA256 hash base64url-encoded. Stored verifier never
// leaves the server — it goes in an httpOnly cookie until the callback.
export function xPkceChallenge(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  return { codeVerifier, codeChallenge };
}

// Step 2: produce the authorize URL the browser should navigate to.
export function xAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes?: readonly string[];
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    scope: (opts.scopes ?? X_OAUTH_SCOPES).join(" "),
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${AUTHORIZE_URL}?${params}`;
}

interface XTokenResponse {
  token_type: "bearer";
  expires_in: number; // seconds
  access_token: string;
  refresh_token?: string;
  scope: string;
}

// Step 3: exchange the authorization code for tokens. Confidential client
// auth (clientId + clientSecret) is required since we registered the app
// as a Web App in the X dev portal.
export async function xExchangeCode(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<XTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
    client_id: opts.clientId,
  });
  const basicAuth = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`X token exchange failed (${res.status}): ${text.slice(0, 400)}`);
  }
  return (await res.json()) as XTokenResponse;
}

// Step 4: refresh the access token before it expires. X may or may not rotate
// the refresh_token — fall back to the existing one if the response omits it.
export async function xRefreshToken(opts: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<XTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
    client_id: opts.clientId,
  });
  const basicAuth = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`X token refresh failed (${res.status}): ${text.slice(0, 400)}`);
  }
  return (await res.json()) as XTokenResponse;
}

// Refresh-if-needed helper called by anyone about to hit an X API endpoint.
// 5-minute leeway means we'll refresh proactively rather than racing the
// boundary; OAuth 2.0 tokens come in at exactly 7200s so the leeway costs
// us nothing in practice and keeps us safe against ±clock skew.
//
// For OAuth 1.0a legacy credentials, this is a no-op — those tokens don't
// expire until the user revokes them in the X dev portal.
export async function loadFreshXCredentials(
  svc: SupabaseClient,
  socialAccountId: string,
  creds: XCredentialsAny,
): Promise<XCredentialsAny> {
  if (isLegacyXCreds(creds)) return creds;
  if (creds.expiresAt - Date.now() > 5 * 60 * 1000) return creds;

  const env = serverEnv();
  if (!env.X_CLIENT_ID || !env.X_CLIENT_SECRET) {
    throw new Error(
      "Cannot refresh X token — X_CLIENT_ID / X_CLIENT_SECRET not set on this deployment.",
    );
  }
  const refreshed = await xRefreshToken({
    clientId: env.X_CLIENT_ID,
    clientSecret: env.X_CLIENT_SECRET,
    refreshToken: creds.refreshToken,
  });
  const next: XCredentials = {
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token ?? creds.refreshToken,
    expiresAt: Date.now() + refreshed.expires_in * 1000,
  };
  await svc
    .from("social_accounts")
    .update({ credentials: next as unknown as Record<string, unknown> })
    .eq("id", socialAccountId);
  return next;
}

// ─── Auth header builder ────────────────────────────────────────────────────
//
// Branches on credential shape: OAuth 2.0 uses a static Bearer header; OAuth
// 1.0a builds a fresh HMAC-SHA1 signature per request (signature includes
// the URL + method + nonce + timestamp).

function legacyOAuth(creds: XCredentialsLegacy): OAuth {
  return new OAuth({
    consumer: { key: creds.apiKey, secret: creds.apiSecret },
    signature_method: "HMAC-SHA1",
    hash_function(base, key) {
      return crypto.createHmac("sha1", key).update(base).digest("base64");
    },
  });
}

function xAuth(creds: XCredentialsAny, url: string, method: "GET" | "POST"): HeadersInit {
  if (isLegacyXCreds(creds)) {
    const oauth = legacyOAuth(creds);
    // oauth-1.0a's Header type ({Authorization: string}) doesn't quite match
    // the Record<string,string> that HeadersInit expects; the runtime shape
    // is identical so the cast is safe.
    return { ...oauth.toHeader(
      oauth.authorize(
        { url, method },
        { key: creds.accessToken, secret: creds.accessTokenSecret },
      ),
    ) } as Record<string, string>;
  }
  return { Authorization: `Bearer ${creds.accessToken}` };
}

export async function xVerify(creds: XCredentialsAny): Promise<{ id: string; username: string }> {
  const url = `${BASE_URL}/2/users/me`;
  const res = await fetch(url, { headers: xAuth(creds, url, "GET") });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`X verify failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const body = (await res.json()) as { data: { id: string; username: string } };
  return { id: body.data.id, username: body.data.username };
}

export async function xPost(
  creds: XCredentialsAny,
  text: string,
  mediaIds?: string[],
  inReplyToTweetId?: string,
): Promise<XPostResult> {
  const url = `${BASE_URL}/2/tweets`;
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
    headers: { ...xAuth(creds, url, "POST"), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { data?: XPostResult; errors?: unknown };
  if (!res.ok || !json.data) {
    throw new Error(`X post failed (${res.status}): ${JSON.stringify(json).slice(0, 400)}`);
  }
  return json.data;
}

// ─── Phase 6.8 — sequential thread posting ─────────────────────────────────
//
// Posts a thread by chaining in_reply_to_tweet_id. Sequential with a 1.2s
// delay between tweets so we don't trip per-second rate caps and the
// previous tweet has time to settle before the next one references it.
// Partial-failure shape mirrors the OAuth 1.0a implementation it replaces.
export interface XPostThreadResult {
  tweetIds: string[];
  lastError?: { tweetIndex: number; error: string };
}

export async function xPostThread(
  creds: XCredentialsAny,
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
    if (i < tweets.length - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return { tweetIds };
}

// Media upload — endpoint depends on auth method. Legacy OAuth 1.0a creds
// MUST use the v1.1 upload.twitter.com host (OAuth 2.0 Bearer rejected there
// historically). OAuth 2.0 PKCE-issued tokens use /2/media/upload. Both
// accept ≤5MB single-shot multipart; >5MB needs chunked INIT/APPEND/
// FINALIZE which we don't support yet.
const UPLOAD_URL_V2 = `${BASE_URL}/2/media/upload`;
const UPLOAD_URL_V1 = "https://upload.twitter.com/1.1/media/upload.json";

export async function xUploadMedia(
  creds: XCredentialsAny,
  bytes: Uint8Array,
  contentType: string,
): Promise<{ media_id_string: string }> {
  if (bytes.byteLength > 5 * 1024 * 1024) {
    throw new Error("Media >5MB requires chunked upload (not implemented).");
  }
  const url = isLegacyXCreds(creds) ? UPLOAD_URL_V1 : UPLOAD_URL_V2;
  const form = new FormData();
  form.append("media", new Blob([bytes as BlobPart], { type: contentType }));

  const res = await fetch(url, {
    method: "POST",
    headers: { ...xAuth(creds, url, "POST") },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`X media upload failed (${res.status}): ${text.slice(0, 400)}`);
  }
  const json = (await res.json()) as { data?: { id?: string }; media_id_string?: string };
  // v2 returns { data: { id } }, v1.1 returns { media_id_string }. Normalise
  // so the dispatcher doesn't need to know which auth method ran.
  const id = json.data?.id ?? json.media_id_string;
  if (!id) {
    throw new Error("X media upload returned no media id.");
  }
  return { media_id_string: id };
}

// Metrics pull. Tweet lookup with public + non-public metrics.
// Non-public metrics (impressions, url_link_clicks) require user-context auth
// AND the user must be the author of the tweet (X privacy rule). Public
// metrics are always returned.
export interface XTweetMetrics {
  impressions: number;
  likes: number;
  reposts: number;
  replies: number;
  clicks: number;
}

export async function xMetrics(creds: XCredentialsAny, tweetId: string): Promise<XTweetMetrics> {
  const params = new URLSearchParams({
    "tweet.fields": "public_metrics,non_public_metrics,organic_metrics",
  });
  const url = `${BASE_URL}/2/tweets/${tweetId}?${params}`;
  const res = await fetch(url, { headers: xAuth(creds, url, "GET") });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`X metrics failed (${res.status}): ${text.slice(0, 200)}`);
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

// ─── Phase 4.5 (Reply Inbox + Engagement Assistant) ─────────────────────

export interface XReplyResult {
  id: string;
  text: string;
}

export async function xReply(
  creds: XCredentialsAny,
  replyText: string,
  inReplyToTweetId: string,
): Promise<XReplyResult> {
  if (!inReplyToTweetId) throw new Error("xReply requires inReplyToTweetId.");
  return xPost(creds, replyText, undefined, inReplyToTweetId);
}

export interface XInboundMention {
  id: string;
  text: string;
  created_at: string;
  author_id: string;
  author_username: string;
  author_name: string | null;
  author_verified: boolean;
  author_follower_count: number | null;
  is_reply: boolean;
  in_reply_to_tweet_id: string | null;
}

export async function xMentions(
  creds: XCredentialsAny,
  userId: string,
  count = 20,
): Promise<XInboundMention[]> {
  const bounded = Math.max(5, Math.min(100, Math.floor(count)));
  const params = new URLSearchParams({
    max_results: String(bounded),
    "tweet.fields": "created_at,author_id,referenced_tweets,in_reply_to_user_id",
    expansions: "author_id,referenced_tweets.id",
    "user.fields": "verified,public_metrics,name",
  });
  const url = `${BASE_URL}/2/users/${encodeURIComponent(userId)}/mentions?${params}`;
  const res = await fetch(url, { headers: xAuth(creds, url, "GET") });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`X mentions failed (${res.status}): ${text.slice(0, 200)}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  const body = (await res.json()) as {
    data?: Array<{
      id: string;
      text: string;
      created_at: string;
      author_id: string;
      in_reply_to_user_id?: string;
      referenced_tweets?: Array<{ type: string; id: string }>;
    }>;
    includes?: {
      users?: Array<{
        id: string;
        username: string;
        name?: string;
        verified?: boolean;
        public_metrics?: { followers_count?: number };
      }>;
    };
  };
  const users = new Map(
    (body.includes?.users ?? []).map((u) => [u.id, u] as const),
  );
  const out: XInboundMention[] = [];
  for (const t of body.data ?? []) {
    const user = users.get(t.author_id);
    const replied = (t.referenced_tweets ?? []).find((r) => r.type === "replied_to");
    out.push({
      id: t.id,
      text: t.text,
      created_at: t.created_at,
      author_id: t.author_id,
      author_username: user?.username ?? t.author_id,
      author_name: user?.name ?? null,
      author_verified: Boolean(user?.verified),
      author_follower_count: user?.public_metrics?.followers_count ?? null,
      is_reply: Boolean(t.in_reply_to_user_id),
      in_reply_to_tweet_id: replied?.id ?? null,
    });
  }
  return out;
}

// ─── Phase 6.6 (Competitor Watch) ───────────────────────────────────────

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
  creds: XCredentialsAny,
  username: string,
): Promise<{ id: string; username: string; name: string | null }> {
  const cleaned = username.replace(/^@/, "").trim();
  const url = `${BASE_URL}/2/users/by/username/${encodeURIComponent(cleaned)}`;
  const res = await fetch(url, { headers: xAuth(creds, url, "GET") });
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
  creds: XCredentialsAny,
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
  const res = await fetch(url, { headers: xAuth(creds, url, "GET") });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`X get user tweets failed (${res.status}): ${text.slice(0, 200)}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  const body = (await res.json()) as { data?: XPublicTweet[] };
  return body.data ?? [];
}
