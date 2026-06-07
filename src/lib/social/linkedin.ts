// LinkedIn OAuth 2.0 (3-legged) + posting via UGC posts endpoint.
//
// Posting requires the `w_member_social` scope. Verify uses `r_liteprofile`
// (or `openid profile` on the newer "Sign In with LinkedIn using OpenID")
// to fetch the member URN we need for ugcPosts.
//
// Company-page posting (Phase 5 follow-up, 2026-05-18) adds the
// Community Management API scopes (`w_organization_social` +
// `r_organization_social`). When granted, the OAuth callback fetches the
// orgs the user administers and persists `targetOrgUrn` on the social
// account row; `linkedinPost` uses that URN as the author. When the
// scope isn't granted (LinkedIn review still pending), the flow falls
// back to personal-profile posting with the new scopes silently dropped
// — old behavior preserved.
//
// Credentials shape stored in social_accounts.credentials:
//   { accessToken, refreshToken?, expiresAt, memberUrn, targetOrgUrn?,
//     grantedScopes? }

import { serverEnv } from "@/lib/env";
import { RetryableError } from "./errors";
import { DmScopeMissingError } from "@/lib/interactions/errors";

export interface LinkedInCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string; // ISO
  memberUrn: string; // e.g. "urn:li:person:abc123"
  // Set when this social_account targets a Company Page rather than the
  // member's personal profile. linkedinPost uses this as the author when
  // present. Unset = personal profile.
  targetOrgUrn?: string; // e.g. "urn:li:organization:12345"
  // Granted scopes from the token response, space-separated. Used by the
  // callback to decide whether to offer the org picker.
  grantedScopes?: string;
}

// Helper: does this credentials blob have permission to post on behalf
// of organizations? True only when the OAuth grant included
// w_organization_social. Defensive — if `grantedScopes` is missing on
// a legacy credentials row, we assume no.
export function hasOrgPostScope(creds: LinkedInCredentials): boolean {
  if (!creds.grantedScopes) return false;
  return creds.grantedScopes.split(/\s+/).includes("w_organization_social");
}

const API = "https://api.linkedin.com";

export interface LinkedInPostResult {
  id: string;
}

export interface LinkedInMetrics {
  impressions: number;
  likes: number;
  comments: number;
  shares: number;
  clicks: number;
}

// ─── OAuth helpers ──────────────────────────────────────────────────────────

export function linkedinAuthorizeUrl(opts: { redirectUri: string; state: string }): string {
  const env = serverEnv();
  if (!env.LINKEDIN_CLIENT_ID) {
    throw new Error("LINKEDIN_CLIENT_ID is not set.");
  }
  // Scope request includes the Community Management API scopes
  // (w_organization_social + r_organization_social). LinkedIn will only
  // GRANT those if the app has been approved for Community Management
  // API — submissions can be pending. If LinkedIn drops the unauthorized
  // scope at consent time, the token response's `scope` field reports
  // what was actually granted, and the callback gracefully falls back
  // to personal-only.
  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.LINKEDIN_CLIENT_ID,
    redirect_uri: opts.redirectUri,
    state: opts.state,
    scope: "openid profile w_member_social w_organization_social r_organization_social",
  });
  return `https://www.linkedin.com/oauth/v2/authorization?${params}`;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope: string;
  token_type: string;
}

export async function linkedinExchangeCode(opts: {
  code: string;
  redirectUri: string;
}): Promise<TokenResponse> {
  const env = serverEnv();
  if (!env.LINKEDIN_CLIENT_ID || !env.LINKEDIN_CLIENT_SECRET) {
    throw new Error("LinkedIn OAuth keys are not set.");
  }
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: env.LINKEDIN_CLIENT_ID,
    client_secret: env.LINKEDIN_CLIENT_SECRET,
  });
  const res = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`LinkedIn token exchange failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as TokenResponse;
}

// List LinkedIn organizations the authed user administers. Requires the
// `r_organization_social` scope to be granted — caller should check
// hasOrgPostScope() on the post-exchange credentials before calling.
//
// LinkedIn's `organizationAcls` endpoint returns role assignments; we
// filter to ADMINISTRATOR and resolve org URNs to display names via a
// follow-up batch call.
export interface LinkedInOrgRef {
  urn: string; // "urn:li:organization:12345"
  name: string;
}

export async function linkedinListOrganizations(accessToken: string): Promise<LinkedInOrgRef[]> {
  const aclRes = await fetch(
    `${API}/v2/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED&projection=(elements*(organization~(localizedName)))`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "LinkedIn-Version": "202404",
        "X-Restli-Protocol-Version": "2.0.0",
      },
    },
  );
  if (!aclRes.ok) {
    // Either no scope grant or no org admin roles. Return empty rather
    // than throwing — callers handle the "no orgs available" case by
    // defaulting to personal-profile posting.
    return [];
  }
  const json = (await aclRes.json()) as {
    elements?: Array<{
      organization?: string;
      "organization~"?: { localizedName?: string };
    }>;
  };
  const out: LinkedInOrgRef[] = [];
  for (const el of json.elements ?? []) {
    if (!el.organization) continue;
    out.push({
      urn: el.organization,
      name: el["organization~"]?.localizedName ?? el.organization,
    });
  }
  return out;
}

export async function linkedinVerify(accessToken: string): Promise<{ urn: string; name: string }> {
  // OpenID userinfo endpoint — returns `sub` we use to construct the URN.
  const res = await fetch(`${API}/v2/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`LinkedIn verify failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { sub: string; name?: string; email?: string };
  return { urn: `urn:li:person:${json.sub}`, name: json.name ?? json.email ?? json.sub };
}

// ─── Posting ────────────────────────────────────────────────────────────────

// LinkedIn's UGC shareCommentary maxes at ~3,000 chars. The dispatcher
// trims at generation time, but we hard-stop here as a defensive guard
// in case a manually-edited post slips through.
const LINKEDIN_MAX_TEXT = 3000;

export async function linkedinPost(
  creds: LinkedInCredentials,
  text: string,
  mediaAssetUrns: string[] = [],
): Promise<LinkedInPostResult> {
  if (text.length > LINKEDIN_MAX_TEXT) {
    throw new Error(
      `LinkedIn post text exceeds ${LINKEDIN_MAX_TEXT} chars (got ${text.length}).`,
    );
  }
  // Author URN: organization when this social_account targets a Page,
  // else the member's personal URN. linkedinPost is otherwise unchanged
  // — the UGC posts endpoint takes either URN form transparently.
  const author = creds.targetOrgUrn ?? creds.memberUrn;
  const body = {
    author,
    lifecycleState: "PUBLISHED",
    specificContent: {
      "com.linkedin.ugc.ShareContent": {
        shareCommentary: { text },
        shareMediaCategory: mediaAssetUrns.length === 0 ? "NONE" : "IMAGE",
        ...(mediaAssetUrns.length > 0
          ? {
              media: mediaAssetUrns.map((urn) => ({
                status: "READY",
                media: urn,
              })),
            }
          : {}),
      },
    },
    visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
  };
  const res = await fetch(`${API}/v2/ugcPosts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`LinkedIn post failed (${res.status}): ${await res.text()}`);
  }
  // UGC API returns the URN in the body as `id`, and also echoes it in
  // `x-restli-id` header. Body is canonical; header is a fallback if a
  // future API change drops the body for some reason.
  const json = (await res.json().catch(() => ({}))) as { id?: string };
  const id = json.id ?? res.headers.get("x-restli-id") ?? null;
  if (!id) throw new Error("LinkedIn post returned no id.");
  return { id };
}

// Two-step image upload: register the asset, then upload bytes to the
// returned URL. Returns the asset URN to attach to a UGC post.
export async function linkedinUploadImage(
  creds: LinkedInCredentials,
  bytes: Uint8Array,
  contentType: string,
): Promise<string> {
  const registerBody = {
    registerUploadRequest: {
      recipes: ["urn:li:digitalmediaRecipe:feedshare-image"],
      owner: creds.memberUrn,
      serviceRelationships: [
        { relationshipType: "OWNER", identifier: "urn:li:userGeneratedContent" },
      ],
    },
  };
  const regRes = await fetch(`${API}/v2/assets?action=registerUpload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(registerBody),
  });
  if (!regRes.ok) {
    throw new Error(`LinkedIn asset register failed (${regRes.status}): ${await regRes.text()}`);
  }
  const regJson = (await regRes.json()) as {
    value: {
      asset: string;
      uploadMechanism: {
        "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest": { uploadUrl: string };
      };
    };
  };
  const uploadUrl =
    regJson.value.uploadMechanism["com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"]
      .uploadUrl;

  const upRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      "Content-Type": contentType,
    },
    body: bytes as BlobPart,
  });
  if (!upRes.ok) {
    throw new Error(`LinkedIn asset upload failed (${upRes.status}): ${await upRes.text()}`);
  }
  return regJson.value.asset;
}

// ─── Video (byte upload via the versioned /rest/ API) ────────────────────────
//
// LinkedIn video uses the newer versioned /rest/ surface (NOT the legacy /v2/
// assets path images use). The flow is initialize → PUT each part to a signed
// URL (no Authorization header on those PUTs) → finalize with the part ETags →
// poll the video URN to AVAILABLE → POST /rest/posts. The created Post URN
// comes back in the `x-restli-id` RESPONSE HEADER, not the body.
//
// We pin a current LinkedIn-Version; bump it when LinkedIn deprecates this one
// (they version monthly as YYYYMM). 500MB hard cap.
const LINKEDIN_VERSION = "202604";
const LINKEDIN_VIDEO_MAX_BYTES = 500 * 1024 * 1024;
const LINKEDIN_VIDEO_POLL_INTERVAL_MS = 5000;
const LINKEDIN_VIDEO_POLL_TIMEOUT_MS = 5 * 60 * 1000;

// Shared fetch for the versioned /rest/ API. Sets the two headers every /rest/
// call needs (LinkedIn-Version + X-Restli-Protocol-Version) plus auth, and
// merges any caller-supplied headers/body.
function linkedinRestFetch(
  creds: LinkedInCredentials,
  path: string,
  init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {},
): Promise<Response> {
  const { headers: extra, ...rest } = init;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${creds.accessToken}`,
    "LinkedIn-Version": LINKEDIN_VERSION,
    "X-Restli-Protocol-Version": "2.0.0",
    ...(extra ?? {}),
  };
  return fetch(`${API}/rest/${path}`, { ...rest, headers });
}

export async function linkedinUploadVideo(
  creds: LinkedInCredentials,
  bytes: Uint8Array,
  fileSizeBytes: number,
): Promise<string> {
  if (fileSizeBytes > LINKEDIN_VIDEO_MAX_BYTES) {
    throw new Error(
      `LinkedIn video exceeds the 500MB limit (got ${(fileSizeBytes / 1024 / 1024).toFixed(0)}MB).`,
    );
  }
  const owner = creds.targetOrgUrn ?? creds.memberUrn;

  // INIT — get the video URN, an upload token, and one or more part upload URLs.
  const initRes = await linkedinRestFetch(creds, "videos?action=initializeUpload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      initializeUploadRequest: {
        owner,
        fileSizeBytes,
        uploadCaptions: false,
        uploadThumbnail: false,
      },
    }),
  });
  if (!initRes.ok) {
    throw new Error(`LinkedIn video init failed (${initRes.status}): ${await initRes.text()}`);
  }
  const initJson = (await initRes.json()) as {
    value?: {
      video?: string;
      uploadToken?: string;
      uploadInstructions?: Array<{ uploadUrl: string; firstByte: number; lastByte: number }>;
    };
  };
  const video = initJson.value?.video;
  const uploadToken = initJson.value?.uploadToken ?? "";
  const instructions = initJson.value?.uploadInstructions ?? [];
  if (!video || instructions.length === 0) {
    throw new Error("LinkedIn video init returned no video URN or upload instructions.");
  }

  // UPLOAD PARTS — PUT each byte range to its signed URL. These PUTs must NOT
  // carry an Authorization header (the URL is pre-signed). Capture each part's
  // ETag in order for finalize.
  const uploadedPartIds: string[] = [];
  for (const part of instructions) {
    const slice = bytes.subarray(part.firstByte, part.lastByte + 1);
    const putRes = await fetch(part.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: slice as BlobPart,
    });
    if (!putRes.ok) {
      throw new Error(
        `LinkedIn video part upload failed (${putRes.status}): ${await putRes.text()}`,
      );
    }
    const etag = putRes.headers.get("etag");
    if (!etag) throw new Error("LinkedIn video part upload returned no ETag.");
    uploadedPartIds.push(etag);
  }

  // FINALIZE — hand back the part ETags in order.
  const finalizeRes = await linkedinRestFetch(creds, "videos?action=finalizeUpload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      finalizeUploadRequest: { video, uploadToken, uploadedPartIds },
    }),
  });
  if (!finalizeRes.ok) {
    throw new Error(`LinkedIn video finalize failed (${finalizeRes.status}): ${await finalizeRes.text()}`);
  }

  // POLL — wait for transcode to reach AVAILABLE before posting.
  await pollVideoStatus(creds, video);
  return video;
}

// Poll a video URN until status === AVAILABLE. Throws on PROCESSING_FAILED, and
// throws RetryableError on timeout so the cron retries next tick.
//
// Hardening path (NOT built now): persist the video URN on the post row and
// resume this poll + post on a later tick instead of re-uploading the bytes.
async function pollVideoStatus(creds: LinkedInCredentials, videoUrn: string): Promise<void> {
  const deadline = Date.now() + LINKEDIN_VIDEO_POLL_TIMEOUT_MS;
  for (;;) {
    const res = await linkedinRestFetch(creds, `videos/${encodeURIComponent(videoUrn)}`);
    if (!res.ok) {
      throw new Error(`LinkedIn video status failed (${res.status}): ${await res.text()}`);
    }
    const json = (await res.json()) as { status?: string };
    const state = json.status;
    if (state === "AVAILABLE") return;
    if (state === "PROCESSING_FAILED") {
      throw new Error("LinkedIn video processing failed (status=PROCESSING_FAILED).");
    }
    // WAITING_UPLOAD / PROCESSING → keep polling.
    if (Date.now() + LINKEDIN_VIDEO_POLL_INTERVAL_MS >= deadline) {
      throw new RetryableError(
        `LinkedIn video ${videoUrn} still processing after ${Math.round(
          LINKEDIN_VIDEO_POLL_TIMEOUT_MS / 1000,
        )}s; will retry next tick.`,
      );
    }
    await new Promise((r) => setTimeout(r, LINKEDIN_VIDEO_POLL_INTERVAL_MS));
  }
}

// Create a video Post via the versioned /rest/posts endpoint. The created Post
// URN is returned in the x-restli-id RESPONSE HEADER (the body is empty on 201).
export async function linkedinPostVideo(
  creds: LinkedInCredentials,
  text: string,
  videoUrn: string,
  title: string,
): Promise<LinkedInPostResult> {
  if (text.length > LINKEDIN_MAX_TEXT) {
    throw new Error(
      `LinkedIn post text exceeds ${LINKEDIN_MAX_TEXT} chars (got ${text.length}).`,
    );
  }
  const author = creds.targetOrgUrn ?? creds.memberUrn;
  const body = {
    author,
    commentary: text,
    visibility: "PUBLIC",
    distribution: {
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    content: {
      media: {
        id: videoUrn,
        // LinkedIn requires a non-empty title on video posts.
        title: title || "Video",
      },
    },
    lifecycleState: "PUBLISHED",
  };
  const res = await linkedinRestFetch(creds, "posts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`LinkedIn video post failed (${res.status}): ${await res.text()}`);
  }
  // 201 Created with the Post URN in the header, body typically empty.
  const id = res.headers.get("x-restli-id");
  if (!id) {
    // Fall back to the body in case a future API change starts returning it.
    const json = (await res.json().catch(() => ({}))) as { id?: string };
    if (json.id) return { id: json.id };
    throw new Error("LinkedIn video post returned no Post URN (x-restli-id header missing).");
  }
  return { id };
}

// ─── Phase 4.5 (Reply Inbox + Engagement Assistant) ─────────────────────
//
// linkedinComments — pull recent first-level comments on a UGC post URN
// via /v2/socialActions/{urn}/comments. Tied to the existing
// `w_member_social` scope (no new scopes needed for our own posts).
//
// linkedinReply — post a reply comment on a UGC post via
// /v2/socialActions/{urn}/comments. Same scope.
//
// Bound to "our own posts" in practice: the poller iterates the
// workspace's recently-posted LinkedIn posts and calls linkedinComments
// on each one. We don't have a generic mentions / search endpoint on
// the personal scope, so this is the universe we can see.

export interface LinkedInInboundComment {
  // Comment URN, e.g. "urn:li:comment:(urn:li:ugcPost:xxx,123)"
  id: string;
  // Author URN, e.g. "urn:li:person:abc". Surfaced as the handle in
  // the inbox; LinkedIn's API returns the URN not the public profile
  // slug on this scope.
  authorUrn: string;
  // Comment body. May be empty when the author replied with media
  // only — we skip empty bodies in the poller.
  message: string;
  // UTC millis. We convert to ISO at the poller boundary.
  createdAtMillis: number;
  // The post URN this comment is on. Carried through so the poller
  // can link to parent_post_id.
  parentUgcPostUrn: string;
}

export async function linkedinComments(
  creds: LinkedInCredentials,
  ugcPostUrn: string,
  count = 25,
): Promise<LinkedInInboundComment[]> {
  const bounded = Math.max(1, Math.min(100, Math.floor(count)));
  const url =
    `${API}/v2/socialActions/${encodeURIComponent(ugcPostUrn)}/comments` +
    `?count=${bounded}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      "X-Restli-Protocol-Version": "2.0.0",
    },
  });
  if (res.status === 403 || res.status === 404) {
    // Same defensive pattern as linkedinMetrics — comments endpoint can
    // return 403 for posts that haven't been backfilled into the social
    // actions service yet. Return [] rather than throwing so the cron
    // walks the next post.
    return [];
  }
  if (!res.ok) {
    const err = new Error(
      `LinkedIn comments failed (${res.status}): ${await res.text()}`,
    );
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  const json = (await res.json()) as {
    elements?: Array<{
      $URN?: string;
      object?: string;
      actor?: string;
      created?: { time?: number };
      message?: { text?: string };
    }>;
  };
  const out: LinkedInInboundComment[] = [];
  for (const c of json.elements ?? []) {
    const urn = c.$URN ?? "";
    const actor = c.actor ?? "";
    const message = c.message?.text ?? "";
    const t = c.created?.time;
    if (!urn || !actor || typeof t !== "number") continue;
    out.push({
      id: urn,
      authorUrn: actor,
      message,
      createdAtMillis: t,
      parentUgcPostUrn: c.object ?? ugcPostUrn,
    });
  }
  return out;
}

export interface LinkedInReplyResult {
  id: string;
}

export async function linkedinReply(
  creds: LinkedInCredentials,
  replyText: string,
  parentUgcPostUrn: string,
): Promise<LinkedInReplyResult> {
  if (replyText.length > LINKEDIN_MAX_TEXT) {
    throw new Error(
      `LinkedIn reply text exceeds ${LINKEDIN_MAX_TEXT} chars (got ${replyText.length}).`,
    );
  }
  const body = {
    actor: creds.memberUrn,
    object: parentUgcPostUrn,
    message: { text: replyText },
  };
  const url = `${API}/v2/socialActions/${encodeURIComponent(parentUgcPostUrn)}/comments`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`LinkedIn reply failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json().catch(() => ({}))) as { $URN?: string };
  const id = json.$URN ?? res.headers.get("x-restli-id") ?? null;
  if (!id) throw new Error("LinkedIn reply returned no id.");
  return { id };
}

// ─── Bet 4 (comment→DM lead capture) — Direct Messages ───────────────────
//
// LinkedIn member-to-member messaging has NO public send API for a standard
// app. The messaging endpoints live behind the gated Marketing Developer
// Platform / Messages API partnership and require scopes a `w_member_social`
// app is never granted (there is no public `w_messaging` self-serve scope).
//
// So the capability check is effectively a HARD no-op: unless the credentials
// blob's recorded `grantedScopes` includes a messaging scope (which today it
// cannot), linkedinDmCapability reports absent and linkedinSendDm throws
// DmScopeMissingError without a network call. This mirrors how IG/Threads
// reply paths are gated by MetaAppReviewPendingError — the call site is wired
// and type-checks, but the action is blocked until a partnership lands. We
// keep the function so the comment→DM core can treat all three channels
// uniformly and audit the scope_missing outcome consistently.

// Messaging scopes that, IF present in grantedScopes, would unlock DM send.
// None are self-serve today; this is the forward-looking allowlist.
const LINKEDIN_MESSAGING_SCOPES = ["w_messaging", "r_messaging", "messaging"];

export interface LinkedInDmCapability {
  granted: boolean;
  reason: "messaging_partnership_required" | null;
}

// Does this credentials blob carry a messaging scope? Defensive: missing
// grantedScopes → no (legacy rows + the steady-state for every account today).
export function linkedinDmCapability(creds: LinkedInCredentials): LinkedInDmCapability {
  const granted = (creds.grantedScopes ?? "")
    .split(/\s+/)
    .some((s) => LINKEDIN_MESSAGING_SCOPES.includes(s));
  return granted
    ? { granted: true, reason: null }
    : { granted: false, reason: "messaging_partnership_required" };
}

export interface LinkedInDmResult {
  id: string;
}

// Send a LinkedIn DM. Throws DmScopeMissingError unless the (currently
// unobtainable) messaging partnership scope is present, so the caller no-ops
// cleanly. If a partnership IS ever granted, the actual Messages API call would
// slot in below the guard.
export async function linkedinSendDm(
  creds: LinkedInCredentials,
  _recipientUrn: string,
  _text: string,
): Promise<LinkedInDmResult> {
  const cap = linkedinDmCapability(creds);
  if (!cap.granted) {
    throw new DmScopeMissingError(
      "linkedin",
      "linkedin_messaging",
      cap.reason ?? undefined,
    );
  }
  // Unreachable today (no self-serve messaging scope). Left intentionally
  // unimplemented rather than shipping a speculative partnership-API call.
  throw new DmScopeMissingError(
    "linkedin",
    "linkedin_messaging",
    "messaging send not implemented (partnership API)",
  );
}

// ─── Metrics ────────────────────────────────────────────────────────────────

export async function linkedinMetrics(
  creds: LinkedInCredentials,
  ugcPostUrn: string,
): Promise<LinkedInMetrics> {
  // /v2/socialActions/{urn} returns likes + comments counts and is the only
  // metrics endpoint available to a personal `w_member_social` token —
  // impressions/shares/clicks live on the organization-share statistics API
  // which requires the gated `r_organization_social` scope.
  //
  // We swallow 403/404 here and return zeros instead of throwing. The hourly
  // pull-metrics cron iterates dozens of posts per workspace; a transient
  // permission blip on one LinkedIn post must not poison the batch.
  const res = await fetch(
    `${API}/v2/socialActions/${encodeURIComponent(ugcPostUrn)}`,
    {
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        "X-Restli-Protocol-Version": "2.0.0",
      },
    },
  );
  if (res.status === 403 || res.status === 404) {
    return { impressions: 0, likes: 0, comments: 0, shares: 0, clicks: 0 };
  }
  if (!res.ok) {
    throw new Error(`LinkedIn metrics failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as {
    likesSummary?: { totalLikes?: number; aggregatedTotalLikes?: number };
    commentsSummary?: { totalFirstLevelComments?: number; aggregatedTotalComments?: number };
  };
  const likes =
    json.likesSummary?.totalLikes ??
    json.likesSummary?.aggregatedTotalLikes ??
    0;
  const comments =
    json.commentsSummary?.totalFirstLevelComments ??
    json.commentsSummary?.aggregatedTotalComments ??
    0;
  return {
    impressions: 0,
    likes,
    comments,
    shares: 0,
    clicks: 0,
  };
}
