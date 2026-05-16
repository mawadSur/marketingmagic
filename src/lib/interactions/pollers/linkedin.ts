// Phase 4.5 — LinkedIn interaction poller.
//
// LinkedIn personal `w_member_social` scope doesn't expose a generic
// mentions / search endpoint. The universe we can see is "comments on
// posts we own". So this poller:
//
//   1. Looks up recent LinkedIn posts owned by the workspace
//      (posts.channel='linkedin' AND external_id is not null), capped
//      at LOOKBACK_DAYS to avoid hammering archived posts.
//   2. For each, calls linkedinComments and adapts each comment into
//      a PollerInteraction.
//
// The caller (cron route) passes in the workspace's own recent posts;
// keeping that fetch in the cron rather than here means this module
// stays portable and doesn't depend on supabase.
//
// Cadence: hourly. LinkedIn has no documented per-route rate caps on
// the personal token but the daily limit is ~1000 calls, so hourly
// fits comfortably.
//
// Idempotent on the comment URN — replays produce zero net rows.

import {
  linkedinComments,
  type LinkedInCredentials,
} from "@/lib/social/linkedin";
import type { PollerResult, PollerInteraction } from "./types";

export interface LinkedInPollContext {
  // Recent LinkedIn posts the workspace owns. external_id is the
  // ugcPost URN. We pull comments on each.
  ownPosts: Array<{ external_id: string; id: string }>;
}

export async function pollLinkedIn(
  creds: LinkedInCredentials,
  ctx: LinkedInPollContext,
): Promise<PollerResult> {
  if (ctx.ownPosts.length === 0) {
    return {
      status: "skipped",
      reason: "no_recent_linkedin_posts",
    };
  }

  const interactions: PollerInteraction[] = [];
  const errors: string[] = [];

  for (const post of ctx.ownPosts) {
    if (!post.external_id) continue;
    try {
      const comments = await linkedinComments(creds, post.external_id, 25);
      for (const c of comments) {
        const message = (c.message ?? "").trim();
        if (message.length === 0) continue;
        interactions.push({
          channel: "linkedin",
          external_id: c.id,
          // LinkedIn returns the author URN, not a public handle, on
          // the personal scope. Surfacing the URN is honest — the
          // detail-view component can offer a "open on LinkedIn" link
          // that the user can resolve.
          author_handle: c.authorUrn,
          author_display_name: null,
          body: message,
          received_at: new Date(c.createdAtMillis).toISOString(),
          // LinkedIn doesn't expose verified flag on this scope.
          verifiedAuthor: false,
          followerCount: null,
          in_reply_to_external_id: c.parentUgcPostUrn,
        });
      }
    } catch (err) {
      // One post failing shouldn't poison the batch. Capture the
      // reason and keep walking.
      errors.push(err instanceof Error ? err.message : "linkedin_comments_failed");
    }
  }

  // Treat the whole call as failed only if EVERY post errored AND we
  // got zero interactions. Otherwise we report `ok` so partial state
  // lands in the DB.
  if (interactions.length === 0 && errors.length > 0) {
    return { status: "failed", reason: errors[0] ?? "linkedin_unknown" };
  }
  return { status: "ok", interactions };
}
