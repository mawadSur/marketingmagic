// TikTok Content Posting API client — OAuth 2.0 PKCE + chunked video publish.
//
// Per-workspace credentials live in social_accounts.credentials with shape:
//   { accessToken, refreshToken, expiresAt }
//
// ⚠️ TikTok deviates from every other provider in two load-bearing ways:
//   1. The public client identifier is `client_key` (env TIKTOK_CLIENT_KEY),
//      NOT `client_id`. Every OAuth call sends `client_key`.
//   2. The authorize host (www.tiktok.com) differs from the token/API host
//      (open.tiktokapis.com). Mixing them up yields opaque 4xx.
//
// Access tokens live only 24h (refresh tokens ~1 year), so any cron that posts
// a day after connect MUST refresh first — loadFreshTikTokCredentials does
// this and persists the (possibly rotated) tokens back via the service role.
//
// Publishing is a strict pipeline, all on open.tiktokapis.com:
//   creator_info/query  → discover the allowed privacy_level options
//   video/init          → declare the FILE_UPLOAD, get publish_id + upload_url
//   PUT upload_url      → stream the bytes in Content-Range chunks
//   status/fetch (poll) → wait for PUBLISH_COMPLETE, read the durable post id
//
// App-audit gate: unaudited / sandbox apps may ONLY post SELF_ONLY. We never
// hardcode a privacy level — creator_info/query returns the allowed set and we
// pick the most public option it offers, so the SAME code auto-goes-public the
// moment TikTok audits the app and adds PUBLIC_TO_EVERYONE to the options.

import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { serverEnv } from "@/lib/env";
import { RetryableError } from "./errors";

// OAuth 2.0 PKCE-issued tokens. Mirrors XCredentials but the expiry math is
// much tighter — TikTok access tokens are 24h, not 2h.
export interface TikTokCredentials {
  // OAuth 2.0 user access token. Expires in ~86400 seconds (24 hours).
  accessToken: string;
  // OAuth 2.0 refresh token. ~1 year (refresh_expires_in 31536000s). Rotates
  // on each refresh — always persist whatever the refresh response returns.
  refreshToken: string;
  // Absolute expiry in unix ms (Date.now() + expires_in*1000 at issue time).
  // We refresh proactively when within 5 minutes of expiry.
  expiresAt: number;
}

export interface TikTokPostResult {
  // The durable, publicly-shareable post id once moderation completes; falls
  // back to the publish_id while the post is still in review.
  id: string;
}

// ─── Hosts ───────────────────────────────────────────────────────────────────
//
// authorize lives on www.tiktok.com; token exchange/refresh AND every Content
// Posting API call live on open.tiktokapis.com. Keep these separate.
const AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";
const API_BASE = "https://open.tiktokapis.com";
const TOKEN_URL = `${API_BASE}/v2/oauth/token/`;

// Scopes are COMMA-separated for TikTok (every other provider uses spaces).
//   user.info.basic — resolve the open_id / display handle after connect.
//   video.publish   — publish a video directly to the user's profile.
//   video.upload    — upload to drafts (required alongside publish for the
//                     FILE_UPLOAD source the init endpoint uses).
const TIKTOK_OAUTH_SCOPES = ["user.info.basic", "video.publish", "video.upload"] as const;

// ─── OAuth 2.0 PKCE primitives ──────────────────────────────────────────────

// Build a PKCE pair. The verifier is a high-entropy random string; the
// challenge is its SHA256 hash base64url-encoded. The verifier never leaves
// the server — it rides in an httpOnly cookie until the callback.
export function tiktokPkceChallenge(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  return { codeVerifier, codeChallenge };
}

// Produce the authorize URL the browser should navigate to. Note `client_key`
// (not client_id) and the COMMA-joined scope string.
export function tiktokAuthorizeUrl(opts: {
  clientKey: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes?: readonly string[];
}): string {
  const params = new URLSearchParams({
    client_key: opts.clientKey,
    scope: (opts.scopes ?? TIKTOK_OAUTH_SCOPES).join(","),
    response_type: "code",
    redirect_uri: opts.redirectUri,
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${AUTHORIZE_URL}?${params}`;
}

interface TikTokTokenResponse {
  access_token: string;
  expires_in: number; // seconds (~86400)
  refresh_token: string;
  refresh_expires_in: number; // seconds (~31536000)
  open_id: string;
  scope: string;
  token_type: "Bearer";
}

// Exchange the authorization code for tokens. TikTok wants
// application/x-www-form-urlencoded with client_key + client_secret in the
// body (no Basic auth header). redirect_uri must EXACTLY match the value sent
// to /authorize, or TikTok rejects with redirect_uri mismatch.
export async function tiktokExchangeCode(opts: {
  clientKey: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<TikTokTokenResponse> {
  const body = new URLSearchParams({
    client_key: opts.clientKey,
    client_secret: opts.clientSecret,
    code: opts.code,
    grant_type: "authorization_code",
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`TikTok token exchange failed (${res.status}): ${text.slice(0, 400)}`);
  }
  return (await res.json()) as TikTokTokenResponse;
}

// Refresh the access token. TikTok rotates the refresh_token on every refresh,
// so we always persist whatever it returns rather than reusing the old one.
export async function tiktokRefreshToken(opts: {
  clientKey: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<TikTokTokenResponse> {
  const body = new URLSearchParams({
    client_key: opts.clientKey,
    client_secret: opts.clientSecret,
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`TikTok token refresh failed (${res.status}): ${text.slice(0, 400)}`);
  }
  return (await res.json()) as TikTokTokenResponse;
}

// Refresh-if-needed helper called before any TikTok API call. 5-minute leeway
// refreshes proactively rather than racing the boundary. CRITICAL for crons:
// a post scheduled a day after connect would 401 without this, because the
// 24h access token has already expired by then.
export async function loadFreshTikTokCredentials(
  svc: SupabaseClient,
  socialAccountId: string,
  creds: TikTokCredentials,
): Promise<TikTokCredentials> {
  if (creds.expiresAt - Date.now() > 5 * 60 * 1000) return creds;

  const env = serverEnv();
  if (!env.TIKTOK_CLIENT_KEY || !env.TIKTOK_CLIENT_SECRET) {
    throw new Error(
      "Cannot refresh TikTok token — TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET not set on this deployment.",
    );
  }
  const refreshed = await tiktokRefreshToken({
    clientKey: env.TIKTOK_CLIENT_KEY,
    clientSecret: env.TIKTOK_CLIENT_SECRET,
    refreshToken: creds.refreshToken,
  });
  const next: TikTokCredentials = {
    accessToken: refreshed.access_token,
    // TikTok rotates the refresh token; fall back to the existing one only if
    // (unexpectedly) absent so we never lose the ability to refresh.
    refreshToken: refreshed.refresh_token || creds.refreshToken,
    expiresAt: Date.now() + refreshed.expires_in * 1000,
  };
  await svc
    .from("social_accounts")
    .update({ credentials: next as unknown as Record<string, unknown> })
    .eq("id", socialAccountId);
  return next;
}

// Bearer header used by every Content Posting API call.
function authHeader(creds: TikTokCredentials): Record<string, string> {
  return { Authorization: `Bearer ${creds.accessToken}` };
}

// Resolve the connected user's handle (and open_id) via user.info.basic. Used
// by the callback to label the social_accounts row. display_name is the
// human-facing handle; open_id is TikTok's stable per-app user identifier.
export async function tiktokVerify(
  creds: TikTokCredentials,
): Promise<{ openId: string; handle: string }> {
  const url = `${API_BASE}/v2/user/info/?fields=open_id,display_name`;
  const res = await fetch(url, { headers: authHeader(creds) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`TikTok verify failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    data?: { user?: { open_id?: string; display_name?: string } };
    error?: { code?: string; message?: string };
  };
  const user = json.data?.user;
  if (!user?.open_id) {
    throw new Error(
      `TikTok verify returned no user${json.error?.message ? `: ${json.error.message}` : ""}.`,
    );
  }
  return { openId: user.open_id, handle: user.display_name || user.open_id };
}

// ─── Creator info (MANDATORY pre-flight) ─────────────────────────────────────
//
// TikTok requires every publish to query creator_info first. It returns the
// privacy_level_options the connected creator is currently allowed to use —
// for an unaudited / sandbox app this is ONLY ["SELF_ONLY"]; once TikTok
// audits the app, PUBLIC_TO_EVERYONE / MUTUAL_FOLLOW_FRIENDS / FOLLOWER_OF_CREATOR
// appear. We read this dynamically and NEVER hardcode PUBLIC_TO_EVERYONE, so
// the same code goes public automatically post-audit with zero changes.

export interface TikTokCreatorInfo {
  privacyLevelOptions: string[];
  // Interaction toggles the creator has disabled at the account level — when
  // true, the corresponding post_info flag MUST be set or init is rejected.
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoPostDurationSec: number | null;
}

export async function tiktokCreatorInfo(creds: TikTokCredentials): Promise<TikTokCreatorInfo> {
  const url = `${API_BASE}/v2/post/publish/creator_info/query/`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...authHeader(creds), "Content-Type": "application/json; charset=UTF-8" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`TikTok creator_info failed (${res.status}): ${text.slice(0, 400)}`);
  }
  const json = (await res.json()) as {
    data?: {
      privacy_level_options?: string[];
      comment_disabled?: boolean;
      duet_disabled?: boolean;
      stitch_disabled?: boolean;
      max_video_post_duration_sec?: number;
    };
    error?: { code?: string; message?: string };
  };
  if (json.error && json.error.code && json.error.code !== "ok") {
    throw new Error(`TikTok creator_info error: ${json.error.message ?? json.error.code}`);
  }
  const d = json.data ?? {};
  const options = d.privacy_level_options ?? [];
  if (options.length === 0) {
    throw new Error(
      "TikTok creator_info returned no privacy_level_options — the creator cannot currently publish.",
    );
  }
  return {
    privacyLevelOptions: options,
    commentDisabled: Boolean(d.comment_disabled),
    duetDisabled: Boolean(d.duet_disabled),
    stitchDisabled: Boolean(d.stitch_disabled),
    maxVideoPostDurationSec: d.max_video_post_duration_sec ?? null,
  };
}

// Pick the most public privacy level the creator is actually allowed to use.
// Ordered most→least public; we take the first option creator_info offered.
// On a sandbox/unaudited app the only option is SELF_ONLY, so that's what we
// use — and the post is private-to-self until TikTok audits the app, at which
// point PUBLIC_TO_EVERYONE shows up and is selected automatically.
const PRIVACY_PREFERENCE = [
  "PUBLIC_TO_EVERYONE",
  "FOLLOWER_OF_CREATOR",
  "MUTUAL_FOLLOW_FRIENDS",
  "SELF_ONLY",
] as const;

export function pickPrivacyLevel(options: string[]): string {
  for (const pref of PRIVACY_PREFERENCE) {
    if (options.includes(pref)) return pref;
  }
  // Fall back to whatever TikTok offered first so we never hardcode a level
  // the creator isn't allowed to use.
  return options[0]!;
}

// ─── Chunked upload sizing ───────────────────────────────────────────────────
//
// TikTok FILE_UPLOAD rules: chunks are 5–64MB; the final chunk may run up to
// 128MB; a file under 5MB must be a single chunk (total_chunk_count = 1). We
// use a 10MB target chunk to stay comfortably inside the band.
const MIN_CHUNK_BYTES = 5 * 1024 * 1024; // 5MB
const TARGET_CHUNK_BYTES = 10 * 1024 * 1024; // 10MB
const TIKTOK_VIDEO_MAX_BYTES = 4 * 1024 * 1024 * 1024; // 4GB hard platform cap

// Compute chunk_size + total_chunk_count for a given file size, honouring
// TikTok's rules (single chunk under 5MB; otherwise even chunks ≥5MB with the
// final chunk absorbing the remainder up to 128MB).
export function tiktokChunkPlan(videoSize: number): {
  chunkSize: number;
  totalChunkCount: number;
} {
  if (videoSize <= MIN_CHUNK_BYTES) {
    // A file ≤5MB must be uploaded as exactly one chunk.
    return { chunkSize: videoSize, totalChunkCount: 1 };
  }
  const chunkSize = TARGET_CHUNK_BYTES;
  // floor() so the last full chunk plus the remainder (which rides on the
  // final chunk via Content-Range) stays ≥ chunkSize and ≤ 128MB.
  const totalChunkCount = Math.max(1, Math.floor(videoSize / chunkSize));
  return { chunkSize, totalChunkCount };
}

// ─── Video init ──────────────────────────────────────────────────────────────
//
// Declares the upload. source=FILE_UPLOAD (not PULL_FROM_URL — supabase.co is
// not a TikTok-verified domain, so a URL pull would be rejected). Returns the
// publish_id (for status polling) and a one-time upload_url (expires 1h after
// init) we PUT the bytes to.

export interface TikTokVideoInitResult {
  publishId: string;
  uploadUrl: string;
}

export async function tiktokVideoInit(
  creds: TikTokCredentials,
  postInfo: {
    title: string;
    privacyLevel: string;
    disableComment?: boolean;
    disableDuet?: boolean;
    disableStitch?: boolean;
  },
  sourceInfo: {
    videoSize: number;
    chunkSize: number;
    totalChunkCount: number;
  },
): Promise<TikTokVideoInitResult> {
  const url = `${API_BASE}/v2/post/publish/video/init/`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...authHeader(creds), "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({
      post_info: {
        title: postInfo.title,
        privacy_level: postInfo.privacyLevel,
        disable_comment: postInfo.disableComment ?? false,
        disable_duet: postInfo.disableDuet ?? false,
        disable_stitch: postInfo.disableStitch ?? false,
      },
      source_info: {
        source: "FILE_UPLOAD",
        video_size: sourceInfo.videoSize,
        chunk_size: sourceInfo.chunkSize,
        total_chunk_count: sourceInfo.totalChunkCount,
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`TikTok video init failed (${res.status}): ${text.slice(0, 400)}`);
  }
  const json = (await res.json()) as {
    data?: { publish_id?: string; upload_url?: string };
    error?: { code?: string; message?: string };
  };
  if (json.error && json.error.code && json.error.code !== "ok") {
    throw new Error(`TikTok video init error: ${json.error.message ?? json.error.code}`);
  }
  const publishId = json.data?.publish_id;
  const uploadUrl = json.data?.upload_url;
  if (!publishId || !uploadUrl) {
    throw new Error("TikTok video init returned no publish_id / upload_url.");
  }
  return { publishId, uploadUrl };
}

// ─── Chunked PUT upload ──────────────────────────────────────────────────────
//
// Stream the bytes to the init-issued upload_url in order. Each chunk carries
// a Content-Range header with byte ranges (END inclusive = end - 1) over the
// TOTAL size, plus Content-Type: video/mp4. We size chunks from the same plan
// init declared so the server's expected layout matches. The final chunk
// absorbs any remainder (up to 128MB), matching tiktokChunkPlan's floor().
export async function tiktokUploadBytes(
  uploadUrl: string,
  bytes: Uint8Array,
  plan: { chunkSize: number; totalChunkCount: number },
): Promise<void> {
  const total = bytes.byteLength;
  for (let i = 0; i < plan.totalChunkCount; i++) {
    const start = i * plan.chunkSize;
    // The last declared chunk runs to the true end of the file so any
    // remainder past the even chunk boundary is uploaded.
    const end = i === plan.totalChunkCount - 1 ? total - 1 : start + plan.chunkSize - 1;
    const chunk = bytes.subarray(start, end + 1);
    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(chunk.byteLength),
        "Content-Range": `bytes ${start}-${end}/${total}`,
      },
      body: chunk as BodyInit,
    });
    // TikTok returns 201 for the final chunk and 206 (partial) for earlier
    // ones; any other status is a hard failure.
    if (res.status !== 201 && res.status !== 206 && !res.ok) {
      const text = await res.text();
      throw new Error(
        `TikTok chunk upload (${i + 1}/${plan.totalChunkCount}) failed (${res.status}): ${text.slice(0, 300)}`,
      );
    }
  }
}

// ─── Status poll ─────────────────────────────────────────────────────────────
//
// Poll post/publish/status/fetch until PUBLISH_COMPLETE (success) or FAILED
// (read fail_reason). The durable, publicly-shareable id is
// `publicaly_available_post_id` — note TikTok's literal misspelling. It only
// appears AFTER moderation, so we use its first element when present and fall
// back to the publish_id otherwise. Bounded poll → RetryableError so the cron
// leaves the post `scheduled` and retries on the next tick instead of failing
// a post still under moderation. Rate limits: status 30/min, init 6/min/user.
const TIKTOK_STATUS_TIMEOUT_MS = 120 * 1000; // ~120s in-tick budget
const TIKTOK_STATUS_INTERVAL_MS = 5 * 1000; // 5s between polls (≤30/min)

export async function tiktokStatus(
  creds: TikTokCredentials,
  publishId: string,
): Promise<{ status: string; postId: string | null; failReason: string | null }> {
  const url = `${API_BASE}/v2/post/publish/status/fetch/`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...authHeader(creds), "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ publish_id: publishId }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`TikTok status fetch failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    data?: {
      status?: string;
      fail_reason?: string;
      // TikTok's literal (misspelled) field name.
      publicaly_available_post_id?: string[];
    };
    error?: { code?: string; message?: string };
  };
  if (json.error && json.error.code && json.error.code !== "ok") {
    throw new Error(`TikTok status error: ${json.error.message ?? json.error.code}`);
  }
  const d = json.data ?? {};
  const postId = d.publicaly_available_post_id?.[0] ?? null;
  return {
    status: d.status ?? "UNKNOWN",
    postId,
    failReason: d.fail_reason ?? null,
  };
}

// Bounded poll loop. Returns the durable post id once PUBLISH_COMPLETE; throws
// on FAILED; throws RetryableError when the budget is exhausted (post still
// processing / under moderation).
async function pollPublishStatus(
  creds: TikTokCredentials,
  publishId: string,
): Promise<string> {
  const deadline = Date.now() + TIKTOK_STATUS_TIMEOUT_MS;
  for (;;) {
    await new Promise((r) => setTimeout(r, TIKTOK_STATUS_INTERVAL_MS));
    const { status, postId, failReason } = await tiktokStatus(creds, publishId);
    if (status === "PUBLISH_COMPLETE") {
      // postId appears only after moderation; fall back to publish_id so we
      // always return a usable external id.
      return postId ?? publishId;
    }
    if (status === "FAILED") {
      throw new Error(
        `TikTok publish failed${failReason ? `: ${failReason}` : ""} (publish_id ${publishId}).`,
      );
    }
    // PROCESSING_UPLOAD / PROCESSING_DOWNLOAD / SEND_TO_USER_INBOX → keep going.
    if (Date.now() + TIKTOK_STATUS_INTERVAL_MS >= deadline) {
      throw new RetryableError(
        `TikTok publish ${publishId} still processing after ${Math.round(
          TIKTOK_STATUS_TIMEOUT_MS / 1000,
        )}s; will retry next tick.`,
      );
    }
  }
}

// ─── Orchestrator ────────────────────────────────────────────────────────────
//
// Chains the full pipeline: creator_info → init → upload → status poll. Returns
// the durable post id (or publish_id while still in moderation). The caller is
// the dispatcher's tiktok video branch.
export async function tiktokPostVideo(
  creds: TikTokCredentials,
  text: string,
  bytes: Uint8Array,
): Promise<TikTokPostResult> {
  const videoSize = bytes.byteLength;
  if (videoSize === 0) throw new Error("TikTok video has zero bytes.");
  if (videoSize > TIKTOK_VIDEO_MAX_BYTES) {
    throw new Error(
      `TikTok video exceeds the 4GB limit (got ${(videoSize / 1024 / 1024).toFixed(0)}MB).`,
    );
  }

  // 1. MANDATORY pre-flight: discover the allowed privacy levels + interaction
  //    toggles. Never hardcode the privacy level — pick from what TikTok says
  //    the creator may use right now (SELF_ONLY on a sandbox/unaudited app).
  const info = await tiktokCreatorInfo(creds);
  const privacyLevel = pickPrivacyLevel(info.privacyLevelOptions);

  // 2. Declare the upload.
  const plan = tiktokChunkPlan(videoSize);
  const init = await tiktokVideoInit(
    creds,
    {
      // TikTok caps the title/caption at 2200 chars; trim defensively.
      title: text.slice(0, 2200),
      privacyLevel,
      // If the creator has disabled an interaction at the account level, the
      // matching flag MUST be set or init is rejected.
      disableComment: info.commentDisabled,
      disableDuet: info.duetDisabled,
      disableStitch: info.stitchDisabled,
    },
    { videoSize, chunkSize: plan.chunkSize, totalChunkCount: plan.totalChunkCount },
  );

  // 3. Stream the bytes to the one-time upload_url.
  await tiktokUploadBytes(init.uploadUrl, bytes, plan);

  // 4. Poll to PUBLISH_COMPLETE; RetryableError if still processing at budget.
  const id = await pollPublishStatus(creds, init.publishId);
  return { id };
}

// ─── Metrics ───────────────────────────────────────────────────────────────
//
// Stub for now. Video insights require the `video.list` / research scopes and
// extra app-review surface that isn't wired up yet; return zeros so the metrics
// cron's dispatch doesn't throw for TikTok posts. Shape mirrors the other
// adapters' metrics return so dispatchMetrics can normalise it uniformly.
export interface TikTokMetrics {
  impressions: number;
  likes: number;
  comments: number;
  shares: number;
}

export async function tiktokMetrics(
  _creds: TikTokCredentials,
  _postId: string,
): Promise<TikTokMetrics> {
  return { impressions: 0, likes: 0, comments: 0, shares: 0 };
}
