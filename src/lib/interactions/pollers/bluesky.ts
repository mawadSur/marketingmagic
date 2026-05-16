// Phase 4.5 — Bluesky interaction poller.
//
// Pulls recent notifications via app.bsky.notification.listNotifications.
// We filter to `mention` and `reply` reasons — likes and follows don't
// belong in the reply inbox.
//
// Auth: existing app-password creds on social_accounts.credentials.
// Bluesky's notification endpoint is gated on session auth (not the
// public read AppView), so we must createSession via the helper.
//
// Cadence: every 15 minutes. Bluesky has no documented rate cap on
// notifications listing; we cap at 30 per call.

import {
  blueskyListNotifications,
  type BlueskyCredentials,
} from "@/lib/social/bluesky";
import type { PollerResult, PollerInteraction } from "./types";

export async function pollBluesky(creds: BlueskyCredentials): Promise<PollerResult> {
  try {
    const notifications = await blueskyListNotifications(creds, 30);
    const interactions: PollerInteraction[] = [];
    for (const n of notifications) {
      // Only mentions + replies + quotes belong in the reply inbox.
      // Likes and follows would flood it. Quotes are interesting
      // engagement and we include them.
      if (!["mention", "reply", "quote"].includes(n.reason)) continue;
      // A mention/reply with no body isn't useful in the inbox UI.
      const body = (n.text ?? "").trim();
      if (body.length === 0) continue;
      interactions.push({
        channel: "bluesky",
        external_id: n.uri,
        author_handle: n.authorHandle,
        author_display_name: n.authorDisplayName,
        body,
        received_at: n.createdAt,
        // Bluesky has no platform-issued verification; pass false so
        // the verified bonus doesn't fire.
        verifiedAuthor: false,
        followerCount: null,
        in_reply_to_external_id: n.parentUri,
      });
    }
    return { status: "ok", interactions };
  } catch (err) {
    return {
      status: "failed",
      reason: err instanceof Error ? err.message : "bluesky_notifications_failed",
    };
  }
}
