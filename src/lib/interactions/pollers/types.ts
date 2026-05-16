// Phase 4.5 (Reply Inbox + Engagement Assistant) — shared poller types.
//
// Each per-channel poller resolves to a list of `PollerInteraction` rows.
// The poll-interactions cron upserts these into public.interactions
// using the (channel, external_id) unique constraint, then recomputes
// priority_score in a follow-up pass.
//
// A poller MUST be idempotent on its returned external_id: replays
// produce zero net rows. We never delete from public.interactions in
// the poller — dismissal is user-driven.

import type { InteractionChannel } from "@/lib/interactions/schema";

export interface PollerInteraction {
  channel: InteractionChannel;
  // Platform-native id for the inbound (tweet id, AT-URI, LinkedIn
  // comment URN). Together with `channel` this is the dedup key.
  external_id: string;
  author_handle: string;
  author_display_name: string | null;
  body: string;
  // ISO string of when the platform says the interaction happened.
  received_at: string;
  // Signals passed straight to computePriorityScore. We pre-resolve in
  // the poller because the platform response is the one place these
  // are cheap to read.
  verifiedAuthor?: boolean;
  followerCount?: number | null;
  // Native platform reply id this is responding TO. Used by the cron
  // to look up parent_post_id by matching against posts.external_id.
  in_reply_to_external_id?: string | null;
}

export interface PollerOk {
  status: "ok";
  interactions: PollerInteraction[];
}

export interface PollerFailed {
  status: "failed";
  reason: string;
}

export interface PollerSkipped {
  status: "skipped";
  reason: string;
}

export type PollerResult = PollerOk | PollerFailed | PollerSkipped;
