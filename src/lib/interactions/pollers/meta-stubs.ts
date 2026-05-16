// Phase 4.5 — IG / Threads poller stubs.
//
// Both helpers throw MetaAppReviewPendingError unconditionally. The
// cron route catches this distinctly so per-account failures roll up
// as "tier_pending" rather than "failed", and the inbox UI shows a
// "coming soon" badge instead of a red error.
//
// When Meta App Review lands the `instagram_manage_comments` and
// `threads_manage_replies` scopes, we swap these out for real
// implementations that mirror pollLinkedIn (walk our own recent posts,
// pull their comments/replies, adapt to PollerInteraction[]).

import { MetaAppReviewPendingError } from "@/lib/interactions/errors";
import type { PollerResult } from "./types";

export async function pollInstagram(): Promise<PollerResult> {
  // We throw rather than return failed so the route handler can
  // distinguish App-Review-pending from real errors via instanceof.
  throw new MetaAppReviewPendingError("instagram_manage_comments");
}

export async function pollThreads(): Promise<PollerResult> {
  throw new MetaAppReviewPendingError("threads_manage_replies");
}
