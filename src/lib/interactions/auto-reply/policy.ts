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

// ════════════════════════════════════════════════════════════════════════
// Bet 4 — comment→DM lead capture: the DM GATE + DM RATE CAP.
//
// Auto-DMing a STRANGER is higher blast-radius than the public reply auto-send
// above (an unsolicited private message reads as spam and can get the account
// flagged). So the DM path reuses the SAME safety primitives — same channel
// set, same kill switch, same windowed counter — but with:
//   * its OWN per-account opt-in (dm_capture_enabled, migration 046),
//   * STRICTER, LOWER per-platform rate caps,
//   * extra gate steps for "a rule is configured" and "a keyword matched".
// It is fail-closed in the identical priority order.
// ════════════════════════════════════════════════════════════════════════

// Per-platform max auto-DMs per account per rolling hour. Deliberately LOWER
// than the reply caps (AUTO_REPLY_RATE_CAP_PER_HOUR) — a stray auto-reply is
// recoverable; a burst of unsolicited DMs is an account-suspension risk. These
// are *auto* caps only; a human can DM by hand without limit.
export const DM_CAPTURE_RATE_CAP_PER_HOUR: Record<AutoReplyChannel, number> = {
  // X DMs to non-followers are heavily abuse-policed. Keep it tiny.
  x: 2,
  // Bluesky chat is young; stay extremely polite.
  bluesky: 3,
  // LinkedIn is the most enforcement-happy; and messaging is partnership-gated
  // anyway, so this is mostly academic — keep it the lowest regardless.
  linkedin: 1,
};

// DM rate-cap guard. Mirrors checkRateCap but against the DM cap table and the
// dm_capture_log 'sent' history. Reuses the same pure windowed counter.
export function checkDmRateCap(
  channel: AutoReplyChannel,
  sentTimestampsMs: number[],
  now: number,
  windowMs: number = RATE_CAP_WINDOW_MS,
): RateCapDecision {
  const cap = DM_CAPTURE_RATE_CAP_PER_HOUR[channel];
  const used = countWithinWindow(sentTimestampsMs, now, windowMs);
  const remaining = Math.max(0, cap - used);
  return { allowed: used < cap, channel, cap, used, remaining };
}

// Machine-readable reason a comment→DM auto-send was held. Superset of the
// reply reasons (it adds no_rule / no_keyword_match) and maps onto the
// dm_capture_log.outcome_reason CHECK in migration 046.
export type DmCaptureBlockReason =
  | "kill_switch"
  | "channel_unsupported"
  | "not_trusted"
  | "not_opted_in"
  | "no_rule"
  | "no_keyword_match"
  | "already_actioned"
  | "rate_capped";

export interface DmGateInput {
  // Channel the interaction arrived on (raw string off the row).
  channel: string;
  // EXISTING publishing trust model: social_accounts.trust_mode. Required true.
  trustMode: boolean;
  // Per-account DM opt-in (migration 046). Required true — defaults false, and
  // is INDEPENDENT of auto_reply_enabled.
  dmCaptureEnabled: boolean;
  // Workspace-wide hard stop (migration 045, REUSED). When true, nothing sends.
  killSwitch: boolean;
  // Is a keyword rule configured for this account? false → no_rule.
  hasRule: boolean;
  // Did the inbound body match a keyword in the rule? false → no_keyword_match.
  keywordMatched: boolean;
  // Current interaction status. Only fresh `unread` rows are DM-eligible.
  interactionStatus: string;
}

export interface DmGateDecision {
  send: boolean;
  reason: DmCaptureBlockReason | null;
}

// The DM trust-gating decision. Fail-closed priority order; the most decisive
// "stop" wins. The rate cap + the per-channel capability check are enforced
// SEPARATELY by the caller (they need DB / network) — this is the pure static
// gate, exhaustively unit-testable for a feature that messages strangers.
export function evaluateDmGate(input: DmGateInput): DmGateDecision {
  // 1. Hard stop first — the shared kill switch overrides everything.
  if (input.killSwitch) return { send: false, reason: "kill_switch" };

  // 2. Channel must be in the shippable set (X/Bluesky/LinkedIn).
  if (!isAutoReplyChannel(input.channel)) {
    return { send: false, reason: "channel_unsupported" };
  }

  // 3. Existing trust model must be on. (Reused — not a new concept.)
  if (input.trustMode !== true) return { send: false, reason: "not_trusted" };

  // 4. The riskier auto-DM behaviour must be explicitly opted into.
  if (input.dmCaptureEnabled !== true) {
    return { send: false, reason: "not_opted_in" };
  }

  // 5. A keyword rule must be configured for this account.
  if (input.hasRule !== true) return { send: false, reason: "no_rule" };

  // 6. The inbound body must actually match a configured keyword.
  if (input.keywordMatched !== true) {
    return { send: false, reason: "no_keyword_match" };
  }

  // 7. Only fresh, un-actioned inbound items are DM-eligible.
  if (input.interactionStatus !== "unread") {
    return { send: false, reason: "already_actioned" };
  }

  return { send: true, reason: null };
}
