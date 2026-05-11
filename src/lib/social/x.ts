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

export async function xPost(creds: XCredentials, text: string): Promise<XPostResult> {
  const url = `${BASE_URL}/2/tweets`;
  const auth = authorize(creds, url, "POST");
  const res = await fetch(url, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const json = (await res.json()) as { data?: XPostResult; errors?: unknown };
  if (!res.ok || !json.data) {
    throw new Error(`X post failed (${res.status}): ${JSON.stringify(json)}`);
  }
  return json.data;
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
