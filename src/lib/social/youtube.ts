// YouTube Data API v3 client — Google OAuth 2.0 + resumable video upload.
//
// Per-workspace credentials live in social_accounts.credentials with shape:
//   { accessToken, refreshToken, expiresAt }
//
// ⚠️ ENABLEMENT (mirrors the TikTok enablement notes): live use needs
//   1. A Google Cloud project with the "YouTube Data API v3" enabled.
//   2. An OAuth 2.0 Web client → YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET env
//      on the deployment. When unset the connect UI is hidden and the OAuth
//      routes redirect with a "youtube_not_configured" error (graceful degrade,
//      same as every other channel).
//   3. The OAuth consent screen must list the `youtube.upload` scope. While the
//      app is in "Testing" mode, only allowlisted test users can connect and
//      every upload is forced to PRIVATE by YouTube regardless of the privacy
//      we request — exactly like TikTok's SELF_ONLY sandbox gate. Once the app
//      passes Google's OAuth verification, public uploads work with no code
//      change because we request `public` and Google honours it post-verify.
//
// Google deviates from the other providers in a few load-bearing ways:
//   1. The token host (oauth2.googleapis.com) differs from the API host
//      (www.googleapis.com). The consent host is accounts.google.com. Mixing
//      them up yields opaque 4xx.
//   2. The refresh token is issued ONLY when access_type=offline AND
//      prompt=consent are sent to the authorize endpoint, and on the FIRST
//      consent. We always send both so a reconnect re-issues one.
//   3. Refresh responses do NOT return a new refresh_token — the original keeps
//      working — so loadFresh* falls back to the stored one (the opposite of
//      TikTok, which rotates on every refresh).
//
// Publishing is a resumable upload, all on www.googleapis.com:
//   POST /upload/youtube/v3/videos?uploadType=resumable  → get the Location URL
//   PUT  <Location URL>  (stream the bytes)              → returns the video id
//
// Access tokens live ~1h, so any cron that posts a day after connect MUST
// refresh first — loadFreshYouTubeCredentials does this and persists the tokens
// back via the service role.

import type { SupabaseClient } from "@supabase/supabase-js";
import { serverEnv } from "@/lib/env";
import { RetryableError } from "./errors";

// Google OAuth 2.0 tokens. Mirrors TikTokCredentials but the refresh token does
// NOT rotate (Google reuses the original), and access tokens are ~1h not 24h.
export interface YouTubeCredentials {
  // OAuth 2.0 access token. Expires in ~3600 seconds (1 hour).
  accessToken: string;
  // OAuth 2.0 refresh token. Long-lived; Google reuses the original across
  // refreshes (does not rotate), so we keep it unless a new one is returned.
  refreshToken: string;
  // Absolute expiry in unix ms (Date.now() + expires_in*1000 at issue time).
  // We refresh proactively when within 5 minutes of expiry.
  expiresAt: number;
}

export interface YouTubePostResult {
  // The durable YouTube video id (the 11-char id in a watch?v= URL).
  id: string;
}

// ─── Hosts ───────────────────────────────────────────────────────────────────
//
// authorize lives on accounts.google.com; token exchange/refresh lives on
// oauth2.googleapis.com; the Data API (incl. the resumable upload endpoint)
// lives on www.googleapis.com. Keep these separate.
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_BASE = "https://www.googleapis.com";
const UPLOAD_URL = `${API_BASE}/upload/youtube/v3/videos`;

// Per-call network timeout. Token/metadata calls are quick; the resumable byte
// PUT streams the whole video, so that caller passes a more generous budget.
// Mirrors the AbortController idiom used in tiktok.ts / lib/sources/*.
const YOUTUBE_FETCH_TIMEOUT_MS = 20_000;
const YOUTUBE_UPLOAD_TIMEOUT_MS = 300_000; // 5 min — a full resumable PUT

async function youtubeFetch(
  url: string,
  init?: RequestInit,
  timeoutMs = YOUTUBE_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`YouTube request timed out after ${timeoutMs / 1000}s.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Scopes are SPACE-separated for Google (TikTok uses commas).
//   youtube.upload      — insert (publish) a video to the user's channel.
//   youtube.readonly    — resolve the channel title/handle after connect.
//   userinfo.profile    — fallback display name if the channel lookup is empty.
export const YOUTUBE_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/userinfo.profile",
] as const;

// ─── OAuth 2.0 ───────────────────────────────────────────────────────────────

// Produce the authorize URL the browser should navigate to. Google requires
// access_type=offline + prompt=consent to mint a refresh_token; without BOTH,
// a reconnect silently returns no refresh_token and the connection dies in an
// hour with no way to recover. include_granted_scopes keeps prior grants.
export function youtubeAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: readonly string[];
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: (opts.scopes ?? YOUTUBE_OAUTH_SCOPES).join(" "),
    state: opts.state,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  });
  return `${AUTHORIZE_URL}?${params}`;
}

interface YouTubeTokenResponse {
  access_token: string;
  expires_in: number; // seconds (~3600)
  // Present only on the FIRST consent (or when prompt=consent forces re-issue).
  // Absent on a plain refresh, so callers must fall back to the stored token.
  refresh_token?: string;
  scope: string;
  token_type: "Bearer";
}

// Exchange the authorization code for tokens. Google wants
// application/x-www-form-urlencoded with client_id + client_secret in the body
// (no Basic auth). redirect_uri must EXACTLY match the value sent to authorize.
export async function youtubeExchangeCode(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<YouTubeTokenResponse> {
  const body = new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    code: opts.code,
    grant_type: "authorization_code",
    redirect_uri: opts.redirectUri,
  });
  const res = await youtubeFetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`YouTube token exchange failed (${res.status}): ${text.slice(0, 400)}`);
  }
  return (await res.json()) as YouTubeTokenResponse;
}

// Refresh the access token. Google does NOT rotate the refresh_token — the
// original keeps working and the response omits it — so callers reuse the
// stored refresh token (the opposite of TikTok's rotate-every-time behaviour).
export async function youtubeRefreshToken(opts: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<YouTubeTokenResponse> {
  const body = new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
  });
  const res = await youtubeFetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`YouTube token refresh failed (${res.status}): ${text.slice(0, 400)}`);
  }
  return (await res.json()) as YouTubeTokenResponse;
}

// Refresh-if-needed helper called before any YouTube API call. 5-minute leeway
// refreshes proactively rather than racing the boundary. CRITICAL for crons: a
// post scheduled a day after connect would 401 without this, because the ~1h
// access token has already expired by then.
export async function loadFreshYouTubeCredentials(
  svc: SupabaseClient,
  socialAccountId: string,
  creds: YouTubeCredentials,
): Promise<YouTubeCredentials> {
  if (creds.expiresAt - Date.now() > 5 * 60 * 1000) return creds;

  const env = serverEnv();
  if (!env.YOUTUBE_CLIENT_ID || !env.YOUTUBE_CLIENT_SECRET) {
    throw new Error(
      "Cannot refresh YouTube token — YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET not set on this deployment.",
    );
  }
  const refreshed = await youtubeRefreshToken({
    clientId: env.YOUTUBE_CLIENT_ID,
    clientSecret: env.YOUTUBE_CLIENT_SECRET,
    refreshToken: creds.refreshToken,
  });
  const next: YouTubeCredentials = {
    accessToken: refreshed.access_token,
    // Google reuses the original refresh token (no rotation); fall back to the
    // stored one when the refresh response omits it (the normal case).
    refreshToken: refreshed.refresh_token || creds.refreshToken,
    expiresAt: Date.now() + refreshed.expires_in * 1000,
  };
  await svc
    .from("social_accounts")
    .update({ credentials: next as unknown as Record<string, unknown> })
    .eq("id", socialAccountId);
  return next;
}

// Bearer header used by every Data API call.
function authHeader(creds: YouTubeCredentials): Record<string, string> {
  return { Authorization: `Bearer ${creds.accessToken}` };
}

// Resolve the connected channel's title (and id) via channels.list?mine=true.
// Used by the callback to label the social_accounts row. The channel title is
// the human-facing name; the channel id is YouTube's stable identifier.
export async function youtubeVerify(
  creds: YouTubeCredentials,
): Promise<{ channelId: string; handle: string }> {
  const url = `${API_BASE}/youtube/v3/channels?part=snippet&mine=true`;
  const res = await youtubeFetch(url, { headers: authHeader(creds) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`YouTube verify failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    items?: Array<{ id?: string; snippet?: { title?: string; customUrl?: string } }>;
    error?: { message?: string };
  };
  const item = json.items?.[0];
  if (!item?.id) {
    throw new Error(
      `YouTube verify returned no channel${json.error?.message ? `: ${json.error.message}` : ""} — the Google account may not have a YouTube channel.`,
    );
  }
  // Prefer the @handle (customUrl) when present, else the channel title, else id.
  const handle = item.snippet?.customUrl || item.snippet?.title || item.id;
  return { channelId: item.id, handle };
}

// ─── Field caps ──────────────────────────────────────────────────────────────
//
// YouTube enforces a 100-char title and 5000-char description on videos.insert.
// We trim defensively so a long caption never gets the whole upload rejected.
const TITLE_MAX = 100;
const DESCRIPTION_MAX = 5000;
const YOUTUBE_VIDEO_MAX_BYTES = 256 * 1024 * 1024 * 1024; // 256GB platform cap

// Derive a title from the post text: the first non-empty line, trimmed to 100
// chars. The full text becomes the description. A title is REQUIRED by
// videos.insert, so we never send an empty one.
export function youtubeTitleFromText(text: string): string {
  const firstLine = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const title = (firstLine || text).trim().slice(0, TITLE_MAX);
  // videos.insert rejects an empty title; fall back to a neutral default.
  return title || "Untitled";
}

// ─── Resumable upload ────────────────────────────────────────────────────────
//
// Two steps. (1) POST the metadata to the resumable endpoint to get a one-time
// upload session URL back in the `Location` header. (2) PUT the raw bytes to
// that URL — the response body is the inserted video resource (with .id).
//
// We default the privacy to "public"; while the OAuth app is unverified
// ("Testing"), YouTube force-downgrades every upload to PRIVATE regardless, so
// the SAME code goes public automatically once Google verifies the app — the
// TikTok SELF_ONLY-until-audited pattern.

interface YouTubeInsertResponse {
  id?: string;
  error?: { message?: string };
}

export async function youtubeUploadVideo(
  creds: YouTubeCredentials,
  bytes: Uint8Array,
  text: string,
  contentType = "video/mp4",
): Promise<YouTubePostResult> {
  const videoSize = bytes.byteLength;
  if (videoSize === 0) throw new Error("YouTube video has zero bytes.");
  if (videoSize > YOUTUBE_VIDEO_MAX_BYTES) {
    throw new Error(
      `YouTube video exceeds the 256GB limit (got ${(videoSize / 1024 / 1024).toFixed(0)}MB).`,
    );
  }

  const snippet = {
    title: youtubeTitleFromText(text),
    description: text.slice(0, DESCRIPTION_MAX),
  };
  // status.privacyStatus="public" is honoured once the app is verified; an
  // unverified/testing app gets a forced PRIVATE upload — no code change needed
  // to go public post-verification.
  const metadata = {
    snippet,
    status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
  };

  // Step 1: open the resumable session. part lists the resource sections we're
  // sending. The video bytes' length/type go in the X-Upload-Content-* headers
  // so YouTube can validate before we stream.
  const initRes = await youtubeFetch(`${UPLOAD_URL}?uploadType=resumable&part=snippet,status`, {
    method: "POST",
    headers: {
      ...authHeader(creds),
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Length": String(videoSize),
      "X-Upload-Content-Type": contentType,
    },
    body: JSON.stringify(metadata),
  });
  if (!initRes.ok) {
    const text = await initRes.text();
    throw new Error(`YouTube upload init failed (${initRes.status}): ${text.slice(0, 400)}`);
  }
  const sessionUrl = initRes.headers.get("location");
  if (!sessionUrl) {
    throw new Error("YouTube upload init returned no resumable session URL (Location header).");
  }

  // Step 2: stream the bytes in a single PUT. The session URL already carries
  // auth (it's a one-time signed URL), but we send the bearer too for parity.
  const putRes = await youtubeFetch(
    sessionUrl,
    {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(videoSize),
      },
      body: bytes as BodyInit,
    },
    YOUTUBE_UPLOAD_TIMEOUT_MS,
  );

  // 308 Resume Incomplete means YouTube wants more bytes — for a single-shot PUT
  // that signals a transient/partial upload, so retry on the next cron tick
  // rather than failing the post permanently.
  if (putRes.status === 308) {
    throw new RetryableError(
      "YouTube resumable upload incomplete (308); will retry next tick.",
    );
  }
  if (!putRes.ok) {
    const text = await putRes.text();
    throw new Error(`YouTube upload failed (${putRes.status}): ${text.slice(0, 400)}`);
  }
  const json = (await putRes.json()) as YouTubeInsertResponse;
  if (json.error || !json.id) {
    throw new Error(`YouTube upload returned no video id${json.error?.message ? `: ${json.error.message}` : ""}.`);
  }
  return { id: json.id };
}

// ─── Metrics ───────────────────────────────────────────────────────────────
//
// Pull view/like/comment counts via videos.list?part=statistics. YouTube has no
// native "shares" count exposed here, so shares is 0. Shape mirrors the other
// adapters' metrics return so dispatchMetrics can normalise it uniformly.
export interface YouTubeMetrics {
  impressions: number; // viewCount — the closest analogue to impressions
  likes: number;
  comments: number;
  shares: number;
}

export async function youtubeMetrics(
  creds: YouTubeCredentials,
  videoId: string,
): Promise<YouTubeMetrics> {
  const url = `${API_BASE}/youtube/v3/videos?part=statistics&id=${encodeURIComponent(videoId)}`;
  const res = await youtubeFetch(url, { headers: authHeader(creds) });
  if (!res.ok) {
    // Don't throw the whole metrics cron over a single channel — return zeros.
    return { impressions: 0, likes: 0, comments: 0, shares: 0 };
  }
  const json = (await res.json()) as {
    items?: Array<{
      statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
    }>;
  };
  const s = json.items?.[0]?.statistics ?? {};
  const n = (v: string | undefined): number => {
    const parsed = Number(v ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    impressions: n(s.viewCount),
    likes: n(s.likeCount),
    comments: n(s.commentCount),
    shares: 0,
  };
}
