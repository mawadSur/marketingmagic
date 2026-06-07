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

// ── Tri-state engagement mode (migration 048) ───────────────────────────
//
// Auto-reply and comment→DM each have a per-account MODE — the safe middle
// state SHADOW sits between OFF and LIVE:
//
//   * 'off'    — the feature does nothing for this account (steady state).
//   * 'shadow' — the gate passes EXACTLY as for 'live' (trust, opt-in, kill
//                switch, rate cap all still apply) and the reply/DM is fully
//                generated, but instead of hitting the channel we ONLY write
//                an audit row (outcome='shadow') with the would-send text. We
//                do NOT post and do NOT flip the interaction. Operators review
//                what the AI WOULD send before trusting it live.
//   * 'live'   — the original behaviour: generate AND send AND flip.
//
// SAFETY: shadow is a zero-blast-radius mode. The mode is resolved here, in
// the pure gate, so the orchestrators branch on a single typed value and can
// NEVER confuse "passed the gate" with "may hit the network".
export const ENGAGEMENT_MODES = ["off", "shadow", "live"] as const;
export type EngagementMode = (typeof ENGAGEMENT_MODES)[number];

// Parse a raw mode value off a social_accounts row into a known mode.
// Fail-closed: anything unrecognised (null, typo, legacy) resolves to 'off'.
export function parseEngagementMode(raw: unknown): EngagementMode {
  return raw === "live" || raw === "shadow" ? raw : "off";
}

// Does this mode DRAFT + run the gate (shadow OR live)? 'off' never engages.
// The two engaging modes share the entire gate + rate cap; they diverge only
// at the send step, which the orchestrator decides from the mode.
export function modeEngages(mode: EngagementMode): boolean {
  return mode === "shadow" || mode === "live";
}

// Does this mode actually HIT THE CHANNEL? Only 'live'. This is the single
// predicate the orchestrators consult before any network send — shadow is
// false, off is false. The send call sites assert on this so a shadow-mode
// row can never reach a platform helper.
export function modeSends(mode: EngagementMode): boolean {
  return mode === "live";
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
  // Is auto-reply ENGAGED for this account — i.e. mode is 'shadow' OR 'live'
  // (migration 048; pass modeEngages(auto_reply_mode)). Required true —
  // 'off' (the default) never engages. Both shadow and live pass the gate
  // identically; the orchestrator decides send-vs-shadow from the mode AFTER
  // the gate, so the safety gate is shared and tested once.
  autoReplyEnabled: boolean;
  // Whether this mode actually SENDS to the network (live), vs only drafts +
  // audits (shadow). Pass modeSends(mode). The trust-mode gate applies ONLY
  // when sending: shadow has zero blast radius (it never posts), so it is
  // deliberately reachable without the publishing trust bar — you must be able
  // to PREVIEW what the AI would say before earning the right to send it live.
  isLive: boolean;
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

  // 3. Existing trust model must be on — but ONLY for live (sending) mode.
  // Shadow drafts + audits and never posts, so it bypasses the trust bar:
  // the whole point of shadow is to preview before you've earned trust.
  if (input.isLive && input.trustMode !== true) {
    return { send: false, reason: "not_trusted" };
  }

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
  // Is comment→DM ENGAGED for this account — i.e. mode is 'shadow' OR 'live'
  // (migration 048; pass modeEngages(dm_capture_mode)). Required true —
  // 'off' (the default) never engages. INDEPENDENT of auto_reply_mode. Both
  // shadow and live pass the gate identically; the orchestrator decides
  // send-vs-shadow from the mode AFTER the gate.
  dmCaptureEnabled: boolean;
  // Whether this mode actually SENDS (live) vs only drafts + audits (shadow).
  // Pass modeSends(mode). Trust-mode is required only for live — shadow sends
  // no DM, so it is reachable without the trust bar (preview before trust).
  isLive: boolean;
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

  // 3. Existing trust model must be on — but ONLY for live (sending) mode.
  // Shadow drafts the DM + audits it and never messages anyone, so it bypasses
  // the trust bar to allow previewing before trust is earned.
  if (input.isLive && input.trustMode !== true) {
    return { send: false, reason: "not_trusted" };
  }

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

// ════════════════════════════════════════════════════════════════════════
// Bet 4 — SETTINGS-SURFACE helpers (pure, UI-facing).
//
// The two helpers below back the channel-settings UI that exposes the runtime
// gates above. They are intentionally PURE (no DB, no network, no clock) so the
// settings page can render synchronously and the enable-gate is exhaustively
// unit-testable — same posture as the runtime gates it mirrors.
// ════════════════════════════════════════════════════════════════════════

// The opt-IN gate for flipping social_accounts.dm_capture_enabled ON from the
// settings UI. This is the settings-time mirror of evaluateDmGate's first three
// structural conditions (channel + trust): you can only OPT IN to auto-DM on a
// connected, shippable channel whose existing publishing trust model is on.
// Turning the toggle OFF is ALWAYS allowed (it's a safety reduction) and is not
// gated here. Fail-closed: the most decisive "stop" wins, in priority order.
export type DmCaptureEnableBlockReason =
  | "not_connected"
  | "channel_unsupported"
  | "not_trusted";

export interface DmCaptureEnableGateInput {
  // Channel the account posts on (raw string off the row).
  channel: string;
  // Account connection status — must be 'connected' to opt in.
  status: string;
  // EXISTING publishing trust model: social_accounts.trust_mode. Required true.
  trustMode: boolean;
}

export interface DmCaptureEnableGateDecision {
  ok: boolean;
  // Set iff ok=false — the first failing condition, fail-closed order.
  reason: DmCaptureEnableBlockReason | null;
}

export function evaluateDmCaptureEnableGate(
  input: DmCaptureEnableGateInput,
): DmCaptureEnableGateDecision {
  // 1. Account must be live before we enable any autonomous behaviour on it.
  if (input.status !== "connected") {
    return { ok: false, reason: "not_connected" };
  }
  // 2. Channel must be in the shippable set (X/Bluesky/LinkedIn).
  if (!isAutoReplyChannel(input.channel)) {
    return { ok: false, reason: "channel_unsupported" };
  }
  // 3. Existing trust model must be on. (Reused — not a new concept.) Mirrors
  //    auto-reply: the riskier auto-DM behaviour builds on publishing trust.
  if (input.trustMode !== true) {
    return { ok: false, reason: "not_trusted" };
  }
  return { ok: true, reason: null };
}

// Static, no-network DM capability HINT for the settings UI. The real send path
// runs a runtime capability probe per channel (xDmCapability / blueskyDmCapability
// / linkedinDmCapability) and no-ops cleanly when it's absent. We do NOT read
// credentials into the settings page just to render a hint — instead we surface
// the *known structural status* of each channel's DM API so the operator
// understands, honestly, that turning the toggle on may no-op until a scope /
// tier / partnership lands. `available: false` means "this will no-op until the
// noted requirement is met"; we never claim a DM will definitely go out.
export interface DmCapabilityHint {
  // Whether DM-send is structurally reachable on this channel today.
  available: boolean;
  // The scope / tier / partnership the channel needs (operator-facing copy).
  requirement: string;
  // One honest sentence for the UI.
  note: string;
}

export function dmCapabilityHint(channel: string): DmCapabilityHint {
  switch (channel) {
    case "x":
      return {
        available: false,
        requirement: "X API paid tier with the dm.write scope",
        note:
          "X only grants dm.write on a paid API tier. Until this account's " +
          "token carries dm.write, auto-DM will no-op (recorded as scope_missing) " +
          "— nothing is sent.",
      };
    case "bluesky":
      return {
        available: true,
        requirement: "Bluesky chat (chat.bsky.*) + recipient opt-in",
        note:
          "Bluesky chat works when the recipient accepts DMs. If they don't, " +
          "the send is a clean no-op (scope_missing) — never an error.",
      };
    case "linkedin":
      return {
        available: false,
        requirement: "LinkedIn Messaging partnership",
        note:
          "LinkedIn messaging is partnership-gated — there is no self-serve " +
          "DM-send scope today. This will no-op (scope_missing) until a " +
          "messaging partnership is granted; configure it now so it's ready.",
      };
    default:
      return {
        available: false,
        requirement: "an X/Bluesky/LinkedIn account",
        note: "Comment→DM lead capture ships on X, Bluesky, and LinkedIn only.",
      };
  }
}
