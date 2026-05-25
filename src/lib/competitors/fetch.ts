// Per-channel competitor-post fetch dispatcher.
//
// Inputs: a watch_handles row.
// Output: FetchOutcome — either an array of normalised FetchedCompetitorPost,
//   or a typed failure (rate_limited / failed) so the cron can update the
//   watch row's status + failure_reason without re-reading the response.
//
// Reality of public-read APIs (V1):
//   - bluesky : full real support via public.api.bsky.app (no auth needed).
//   - x       : best-effort via OAuth creds in social_accounts. Requires
//               the workspace to have an active X social account because
//               GET /2/users/:id/tweets is OAuth-only.
//   - linkedin, instagram, threads: their public-read endpoints require
//               OAuth scopes that we don't currently hold. We fail with
//               channel_unsupported so the UI surfaces "Coming soon."
//
// Anti-harassment note: this module only reads public posts. It does not
// expose anything that takes adversarial action on a handle (no follow,
// no DM, no quote-tweet). The system prompt that consumes these posts
// (extract-pattern.ts) enforces the same constraint downstream.

import { supabaseService } from "@/lib/supabase/service";
import {
  blueskyGetAuthorFeed,
  blueskyWebUrl,
  type BlueskyAuthorPost,
} from "@/lib/social/bluesky";
import {
  xGetUserPosts,
  xResolveUsername,
  loadFreshXCredentials,
  type XCredentials,
  type XPublicTweet,
} from "@/lib/social/x";
import type { Database, CompetitorWatchChannel } from "@/lib/db/types";
import type { FetchOutcome, FetchedCompetitorPost } from "@/lib/competitors/schema";

type WatchHandleRow = Database["public"]["Tables"]["watch_handles"]["Row"];

export interface FetchInputs {
  handle: WatchHandleRow;
  count: number;
}

export async function fetchCompetitorPosts(input: FetchInputs): Promise<FetchOutcome> {
  const { handle } = input;
  switch (handle.channel) {
    case "bluesky":
      return fetchBlueskyCompetitor(handle, input.count);
    case "x":
      return fetchXCompetitor(handle, input.count);
    case "linkedin":
    case "instagram":
    case "threads":
      return {
        status: "failed",
        reason: "channel_unsupported",
      };
    default: {
      // Exhaustive guard for the future channel union.
      const _exhaustive: never = handle.channel as never;
      return { status: "failed", reason: `unknown_channel:${String(_exhaustive)}` };
    }
  }
}

// ─── Bluesky ─────────────────────────────────────────────────────────

async function fetchBlueskyCompetitor(
  handle: WatchHandleRow,
  count: number,
): Promise<FetchOutcome> {
  try {
    const feed = await blueskyGetAuthorFeed(handle.handle, count);
    const posts = feed.map((p) => normaliseBskyPost(handle.handle, p));
    return { status: "ok", posts };
  } catch (err) {
    const status = (err as Error & { status?: number }).status;
    if (status === 429) {
      return { status: "rate_limited", reason: "bluesky_429" };
    }
    if (status === 400 || status === 404) {
      return { status: "failed", reason: `handle_not_found:${status}` };
    }
    return { status: "failed", reason: err instanceof Error ? err.message : "unknown" };
  }
}

function normaliseBskyPost(handle: string, post: BlueskyAuthorPost): FetchedCompetitorPost {
  return {
    external_id: post.uri,
    posted_at: post.createdAt,
    text: post.text,
    post_url: blueskyWebUrl(handle, post.uri),
    likes: post.likeCount,
    reposts: post.repostCount,
    replies: post.replyCount,
    impressions: null, // Bluesky doesn't publish impressions.
  };
}

// ─── X ───────────────────────────────────────────────────────────────
//
// We need OAuth creds to read public timelines. We use the first connected
// X social account in the watch row's workspace as the reader identity.
// This isn't perfect (the read counts as the connected user's API budget)
// but it's the only way to read X data without a dedicated app-level token.

async function fetchXCompetitor(
  handle: WatchHandleRow,
  count: number,
): Promise<FetchOutcome> {
  const picked = await pickXCredsForWorkspace(handle.workspace_id);
  if (!picked) {
    return {
      status: "failed",
      reason: "no_x_account_connected",
    };
  }
  const svc = supabaseService();
  // Refresh the access_token if it's near expiry — competitor watch runs
  // hourly so any account untouched for >2h would otherwise fail with 401.
  const creds = await loadFreshXCredentials(svc, picked.id, picked.creds);
  try {
    const resolved = await xResolveUsername(creds, handle.handle);
    const tweets = await xGetUserPosts(creds, resolved.id, count);
    const posts = tweets.map((t) => normaliseXTweet(handle.handle, t));
    return { status: "ok", posts };
  } catch (err) {
    const status = (err as Error & { status?: number }).status;
    if (status === 429) return { status: "rate_limited", reason: "x_429" };
    if (status === 401 || status === 403) {
      return { status: "failed", reason: `x_auth_${status}` };
    }
    if (status === 404) return { status: "failed", reason: "x_user_not_found" };
    return { status: "failed", reason: err instanceof Error ? err.message : "unknown" };
  }
}

function normaliseXTweet(handle: string, t: XPublicTweet): FetchedCompetitorPost {
  const m = t.public_metrics ?? {};
  return {
    external_id: t.id,
    posted_at: t.created_at,
    text: t.text,
    post_url: `https://x.com/${handle}/status/${t.id}`,
    likes: m.like_count ?? null,
    reposts: m.retweet_count ?? null,
    replies: m.reply_count ?? null,
    impressions: m.impression_count ?? null,
  };
}

async function pickXCredsForWorkspace(
  workspaceId: string,
): Promise<{ id: string; creds: XCredentials } | null> {
  const svc = supabaseService();
  const { data } = await svc
    .from("social_accounts")
    .select("id, credentials, status")
    .eq("workspace_id", workspaceId)
    .eq("channel", "x")
    .eq("status", "connected")
    .order("created_at", { ascending: true })
    .limit(1);
  const row = data?.[0];
  if (!row || !row.credentials || typeof row.credentials !== "object") return null;
  const c = row.credentials as Record<string, unknown>;
  if (
    typeof c.accessToken === "string" &&
    typeof c.refreshToken === "string" &&
    typeof c.expiresAt === "number"
  ) {
    return {
      id: row.id,
      creds: {
        accessToken: c.accessToken,
        refreshToken: c.refreshToken,
        expiresAt: c.expiresAt,
      },
    };
  }
  return null;
}

// Convenience: surface what's actually supported so the UI can render
// "Coming soon" labels rather than letting users add rows that will fail.
export function isChannelSupported(channel: CompetitorWatchChannel): boolean {
  return channel === "bluesky" || channel === "x";
}
