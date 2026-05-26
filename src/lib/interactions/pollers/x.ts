// Phase 4.5 — X (Twitter) interaction poller.
//
// Pulls recent mentions of the authed user via xMentions and adapts each
// one into a PollerInteraction. Idempotent on tweet id; replays produce
// zero net rows (the (channel, external_id) unique constraint dedups).
//
// Auth: existing OAuth 1.0a creds on social_accounts.credentials. No new
// scopes required — mentions sit on the same elevated tier as
// xGetUserPosts that competitor watch already uses.
//
// Cadence: every 15 minutes via the cron route. We pull 20 per call;
// the API has a 75-req/15min limit per user so this is well under.

import { xMentions, xVerify, type XCredentialsAny } from "@/lib/social/x";
import type { PollerResult, PollerInteraction } from "./types";

export async function pollX(creds: XCredentialsAny): Promise<PollerResult> {
  // We need the authed user id to ask for THEIR mentions. xVerify
  // returns it cheaply (1 request). We could cache this on the
  // social_accounts row in a follow-up, but for now the cost is a
  // single GET /2/users/me per poll which is acceptable.
  let userId: string;
  try {
    const me = await xVerify(creds);
    userId = me.id;
  } catch (err) {
    return {
      status: "failed",
      reason: err instanceof Error ? err.message : "x_verify_failed",
    };
  }

  try {
    const mentions = await xMentions(creds, userId, 20);
    const interactions: PollerInteraction[] = mentions.map((m) => ({
      channel: "x",
      external_id: m.id,
      author_handle: m.author_username,
      author_display_name: m.author_name,
      body: m.text,
      received_at: m.created_at,
      verifiedAuthor: m.author_verified,
      followerCount: m.author_follower_count,
      in_reply_to_external_id: m.in_reply_to_tweet_id,
    }));
    return { status: "ok", interactions };
  } catch (err) {
    return {
      status: "failed",
      reason: err instanceof Error ? err.message : "x_mentions_failed",
    };
  }
}
