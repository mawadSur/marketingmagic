// Phase 4.5 (Reply Inbox + Engagement Assistant) — priority scoring.
//
// Blends a handful of cheap signals into a 0-100 score the inbox sorts by.
// All signals are additive with a top-end clamp, plus an age decay term
// at the end. We do NOT call out to any model here — keeping the scoring
// O(1) means we can recompute on every poll without thinking about it.
//
// Signal weights (max contribution each):
//
//   verified-author          → +30  (X/LinkedIn verified flag, IG blue tick)
//   follower_count log-scale → +20  (log10 of followers, clamped 0..20)
//   customer-list match      → +25  (handle appears in brand_briefs.reference_links)
//   question-detection       → +15  (body ends "?" or starts with who/what/why/how)
//   age decay                → -1 per hour past 48h, clamped at -30
//
// Sum is clamped into [0, 100]. We treat NULL / missing signals as "no
// contribution" rather than fail — the priority recompute on poll-time
// is best-effort and must never throw.
//
// The brand_briefs.reference_links column is a string[] of arbitrary
// links the user has stashed. For the customer-list match we look for
// any handle-shaped substring; this is intentionally loose (a single
// false-positive on a marketing page is a +25, not the end of the
// world). When we later add a dedicated customer_handles column we
// swap this in place — the call signature stays.

import type { InteractionChannel } from "./schema";

export interface PriorityInteractionInput {
  // Raw body of the inbound — used for question detection.
  body: string;
  // ISO timestamp of when the platform says the interaction happened.
  // Used for the age-decay term.
  received_at: string;
  // Platform-native author handle. Used for customer-list matching.
  // Channel-specific (we'll search reference_links case-insensitively).
  author_handle: string;
  channel: InteractionChannel;
}

export interface PriorityContext {
  // Whether the platform reports the author as verified. The X v2 API
  // exposes `verified` on the user object; LinkedIn doesn't (we pass
  // false there for now). Bluesky has no concept of platform-issued
  // verification, so we always pass false.
  verifiedAuthor?: boolean;
  // Author's follower count, if the platform reports it. Optional —
  // when missing the signal contributes 0.
  followerCount?: number | null;
  // The workspace's brand_briefs.reference_links array. We search for
  // the author handle inside each string (case-insensitive). Anything
  // shaped like `@handle`, `linkedin.com/in/handle`, or `bsky.app/
  // profile/handle.bsky.social` matches.
  referenceLinks?: string[];
}

// Public weight constants. Exported so tests + the explainer UI can
// reference them without re-typing magic numbers.
export const VERIFIED_AUTHOR_BONUS = 30;
export const FOLLOWER_LOG_MAX = 20;
export const CUSTOMER_MATCH_BONUS = 25;
export const QUESTION_BONUS = 15;
export const AGE_DECAY_START_HOURS = 48;
export const AGE_DECAY_PER_HOUR = 1;
export const AGE_DECAY_FLOOR = -30;

// Question-detector. Returns true when the body either ends with a "?"
// or starts with a recognised wh- / how- word. We strip a leading
// "@handle" mention because most replies start with one.
function isQuestion(body: string): boolean {
  const cleaned = body.replace(/^\s*@[\w.\-]+\s*/, "").trim();
  if (cleaned.endsWith("?")) return true;
  const firstWord = cleaned.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  return ["who", "what", "why", "how", "when", "where", "which"].includes(firstWord);
}

// Customer-list matcher. Walks `referenceLinks`, returns true on first
// case-insensitive substring hit for the author handle (stripped of "@").
// Cheap O(n*m); reference_links is bounded at ~50 entries in practice.
function matchesCustomerList(authorHandle: string, referenceLinks: string[] | undefined): boolean {
  if (!referenceLinks || referenceLinks.length === 0) return false;
  const needle = authorHandle.replace(/^@/, "").toLowerCase();
  if (needle.length < 2) return false;
  for (const link of referenceLinks) {
    if (typeof link !== "string") continue;
    if (link.toLowerCase().includes(needle)) return true;
  }
  return false;
}

// Follower-log bonus. log10(followers) clamped to [0, 20].
// 100 followers → 2; 10k → 4; 1M → 6; 1B → 9. We multiply by ~3.3 to
// stretch into the 0-20 range so a 10k-follower account gets a
// meaningful boost without a million-follower whale saturating to 20.
function followerLogBonus(followerCount: number | null | undefined): number {
  if (!followerCount || followerCount < 10) return 0;
  const log = Math.log10(followerCount);
  const scaled = log * 3.3;
  return Math.max(0, Math.min(FOLLOWER_LOG_MAX, scaled));
}

// Age decay. Past 48h the score loses 1 point per additional hour,
// floored at -30. We compute relative to `now` (default = system clock,
// override-able for deterministic tests).
function ageDecay(receivedAt: string, now: Date = new Date()): number {
  const received = new Date(receivedAt);
  if (Number.isNaN(received.valueOf())) return 0;
  const hoursElapsed = (now.valueOf() - received.valueOf()) / (60 * 60 * 1000);
  if (hoursElapsed <= AGE_DECAY_START_HOURS) return 0;
  const past = hoursElapsed - AGE_DECAY_START_HOURS;
  return Math.max(AGE_DECAY_FLOOR, -1 * AGE_DECAY_PER_HOUR * past);
}

export function computePriorityScore(
  interaction: PriorityInteractionInput,
  context: PriorityContext = {},
  now: Date = new Date(),
): number {
  let score = 0;

  if (context.verifiedAuthor) score += VERIFIED_AUTHOR_BONUS;
  score += followerLogBonus(context.followerCount ?? null);
  if (matchesCustomerList(interaction.author_handle, context.referenceLinks)) {
    score += CUSTOMER_MATCH_BONUS;
  }
  if (isQuestion(interaction.body)) score += QUESTION_BONUS;
  score += ageDecay(interaction.received_at, now);

  // Clamp into [0, 100]. We don't round — the DB column is numeric and
  // the UI shows the rounded value at render time.
  return Math.max(0, Math.min(100, score));
}
