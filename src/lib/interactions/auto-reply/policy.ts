// Bet 4 — Autonomous Community Engagement: the auto-reply GATE + RATE CAP.
//
// =======================================================================
// SAFETY-CRITICAL, PURE LOGIC.
// =======================================================================
// This module is the single decision point that answers "may we auto-send
// a reply for this interaction right now?". It is intentionally:
//
//   * PURE — no DB, no network, no clock reads except what's passed in.
//     The caller (auto-reply/send.ts) loads state and feeds it here. That
//     makes the gate exhaustively unit-testable, which is the whole point
//     for a feature that auto-publishes public content.
//   * FAIL-CLOSED — every ambiguous or unknown condition resolves to
//     "do not send". Auto-send is opt-in on top of an opt-in; a missing
//     flag, an unknown channel, or a parse failure means we hold.
//
// The trust concept we gate on is the EXISTING publishing trust model:
// social_accounts.trust_mode (the same boolean that lets outbound posts
// skip approval). We do NOT invent a second trust model. trust_mode is
// necessary; the per-account auto_reply_enabled opt-in and the workspace
// kill switch are additional conservative gates layered on top.
// =======================================================================

import type { InteractionChannel } from "../schema";

// Channels we can auto-send replies on in this slice. IG / Threads are
// excluded: their reply paths are blocked on Meta App Review
// (see src/lib/interactions/errors.ts). Anything outside this set
// fails the gate with `channel_unsupported`.
export const AUTO_REPLY_CHANNELS = ["x", "bluesky", "linkedin"] as const;
export type AutoReplyChannel = (typeof AUTO_REPLY_CHANNELS)[number];

export function isAutoReplyChannel(
  channel: string,
): channel is AutoReplyChannel {
  return (AUTO_REPLY_CHANNELS as readonly string[]).includes(channel);
}

// ── Rate cap ──────────────────────────────────────────────────────────
//
// Per-platform max auto-replies per account per rolling hour. Platforms
// punish reply bursts as spam (suspension / shadowban), so we keep this
// deliberately low. These are the *auto* caps only — a human can still
// reply by hand without limit through the inbox composer.
//
// Tuned conservatively: even a popular post rarely needs >N hands-off
// replies an hour, and overshooting the cap fails safe (we just hold the
// rest as suggestions for human review).
export const AUTO_REPLY_RATE_CAP_PER_HOUR: Record<AutoReplyChannel, number> = {
  // X aggressively rate-limits + spam-flags reply automation.
  x: 5,
  // Bluesky is laxer but young; stay polite.
  bluesky: 8,
  // LinkedIn is the most enforcement-happy on automation. Keep it tiny.
  linkedin: 3,
};

export const RATE_CAP_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Counts how many auto-replies already SENT for an account fall inside the
// trailing window. `sentTimestamps` is the list of created_at values
// (epoch ms) from auto_reply_log rows with outcome='sent' for this account.
// Pure: the caller passes `now` and the timestamps.
export function countWithinWindow(
  sentTimestampsMs: number[],
  now: number,
  windowMs: number = RATE_CAP_WINDOW_MS,
): number {
  const cutoff = now - windowMs;
  let n = 0;
  for (const t of sentTimestampsMs) {
    if (Number.isFinite(t) && t > cutoff) n += 1;
  }
  return n;
}

export interface RateCapDecision {
  allowed: boolean;
  channel: AutoReplyChannel;
  cap: number;
  used: number;
  remaining: number;
}

// Rate-cap guard. Returns whether one more auto-reply is allowed for the
// account right now, given the per-channel cap and the recent sent history.
export function checkRateCap(
  channel: AutoReplyChannel,
  sentTimestampsMs: number[],
  now: number,
  windowMs: number = RATE_CAP_WINDOW_MS,
): RateCapDecision {
  const cap = AUTO_REPLY_RATE_CAP_PER_HOUR[channel];
  const used = countWithinWindow(sentTimestampsMs, now, windowMs);
  const remaining = Math.max(0, cap - used);
  return {
    allowed: used < cap,
    channel,
    cap,
    used,
    remaining,
  };
}

// ── Trust gate ────────────────────────────────────────────────────────
//
// Machine-readable reason an auto-send was held. Mirrors the CHECK on
// auto_reply_log.outcome_reason in migration 045.
export type AutoReplyBlockReason =
  | "kill_switch"
  | "not_trusted"
  | "not_opted_in"
  | "rate_capped"
  | "channel_unsupported"
  | "already_replied"
  | "empty_draft";

export interface AutoReplyGateInput {
  // Channel the interaction arrived on (raw string off the row).
  channel: string;
  // EXISTING publishing trust model: social_accounts.trust_mode. Same
  // boolean that gates auto-publish of posts. Required to be true.
  trustMode: boolean;
  // Per-account opt-in (migration 045). Required to be true — defaults
  // false so auto-publish trust never silently enables auto-reply.
  autoReplyEnabled: boolean;
  // Workspace-wide hard stop (migration 045). When true, nothing sends.
  killSwitch: boolean;
  // Current interaction status. We never auto-reply to something already
  // replied/dismissed/snoozed; only fresh `unread` rows are eligible.
  interactionStatus: string;
  // Whether we actually have a non-empty drafted reply to send.
  hasDraft: boolean;
}

export interface AutoReplyGateDecision {
  send: boolean;
  // Set iff send=false — the first failing condition, fail-closed order.
  reason: AutoReplyBlockReason | null;
}

// The trust-gating decision. Evaluated in fail-closed priority order: the
// most decisive "stop" wins. The rate cap is enforced SEPARATELY by the
// caller (it needs the DB count) — pass its result in via `rateAllowed`
// when you want a single combined verdict, or use this for the static
// gate and checkRateCap for the dynamic one.
export function evaluateAutoReplyGate(
  input: AutoReplyGateInput,
): AutoReplyGateDecision {
  // 1. Hard stop first — the kill switch overrides everything.
  if (input.killSwitch) return { send: false, reason: "kill_switch" };

  // 2. Channel must be in the shippable set (X/Bluesky/LinkedIn).
  if (!isAutoReplyChannel(input.channel)) {
    return { send: false, reason: "channel_unsupported" };
  }

  // 3. Existing trust model must be on. (Reused — not a new concept.)
  if (input.trustMode !== true) return { send: false, reason: "not_trusted" };

  // 4. The riskier auto-reply behaviour must be explicitly opted into.
  if (input.autoReplyEnabled !== true) {
    return { send: false, reason: "not_opted_in" };
  }

  // 5. Only fresh, un-actioned inbound items are auto-reply-eligible.
  if (input.interactionStatus !== "unread") {
    return { send: false, reason: "already_replied" };
  }

  // 6. Must have something to send.
  if (!input.hasDraft) return { send: false, reason: "empty_draft" };

  return { send: true, reason: null };
}
