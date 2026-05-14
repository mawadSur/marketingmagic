// LinkedIn OAuth 2.0 (3-legged) + posting via UGC posts endpoint.
//
// Posting requires the `w_member_social` scope. Verify uses `r_liteprofile`
// (or `openid profile` on the newer "Sign In with LinkedIn using OpenID")
// to fetch the member URN we need for ugcPosts.
//
// Credentials shape stored in social_accounts.credentials:
//   { accessToken, refreshToken?, expiresAt, memberUrn }

import { serverEnv } from "@/lib/env";

export interface LinkedInCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string; // ISO
  memberUrn: string; // e.g. "urn:li:person:abc123"
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
  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.LINKEDIN_CLIENT_ID,
    redirect_uri: opts.redirectUri,
    state: opts.state,
    scope: "openid profile w_member_social",
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
  const body = {
    author: creds.memberUrn,
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
