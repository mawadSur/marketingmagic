// TODO #0 (gap 1) — the SPAM-IGNORE GATE.
//
// =======================================================================
// SAFETY-CRITICAL, PURE LOGIC. Mirrors policy.ts (the Bet 4 auto-reply
// gate) exactly: PURE (no DB / network / clock except what's passed in)
// and FAIL-CLOSED (any ambiguous condition resolves to "do not ignore").
//
// Auto-ignoring a row is a one-way drop from the operator's default view —
// a false positive hides a real customer reply. So the action is gated the
// same way auto-reply is, and it REUSES the tri-state engagement model:
//
//   * 'off'    — never auto-ignore (the default; steady state).
//   * 'shadow' — classify + AUDIT what we WOULD ignore, but DO NOT flip the
//                interaction. Operator reviews the would-ignore log before
//                trusting it live. Zero blast radius. Crucially, shadow is
//                reachable WITHOUT the publishing trust bar — you preview
//                before you earn the right to act.
//   * 'live'   — classify, AUDIT, and flip status → 'ignored'.
//
// We reuse EngagementMode + parseEngagementMode / modeEngages / modeSends
// from policy.ts so there is ONE tri-state model in the codebase. We also
// reuse the workspace kill switch — when the auto-reply kill switch is on,
// spam-ignore is silenced too (one "stop everything" lever).
// =======================================================================

import { isAutoReplyChannel } from "./policy";

// Machine-readable reason a spam-ignore was held. Mirrors the CHECK on
// spam_ignore_log.outcome_reason in migration 056.
export type SpamIgnoreBlockReason =
  | "kill_switch"
  | "not_trusted"
  | "not_opted_in"
  | "channel_unsupported"
  | "already_actioned"
  | "not_spam";

export interface SpamIgnoreGateInput {
  // Channel the interaction arrived on (raw string off the row). We only
  // auto-ignore on the same shippable set as auto-reply (X/Bluesky/LinkedIn);
  // IG/Threads inbound is read-only pending Meta App Review anyway.
  channel: string;
  // EXISTING publishing trust model: social_accounts.trust_mode. Required
  // true to actually FLIP a row (live) — but NOT for shadow (preview-first).
  trustMode: boolean;
  // Is spam-ignore ENGAGED — i.e. workspace spam_ignore_mode is 'shadow' OR
  // 'live' (pass modeEngages(mode)). 'off' (the default) never engages.
  spamIgnoreEnabled: boolean;
  // Whether this mode actually FLIPS the row (live) vs only audits (shadow).
  // Pass modeSends(mode). Trust is required only when flipping; shadow audits
  // with zero blast radius, so it is reachable without the trust bar.
  isLive: boolean;
  // Workspace-wide hard stop (REUSES auto_reply_kill_switch). When true,
  // nothing is auto-ignored for any account in the workspace.
  killSwitch: boolean;
  // Current interaction status. We only auto-ignore fresh `unread` rows —
  // a row the operator already touched (read/replied/snoozed/dismissed) is
  // never silently re-classified and dropped.
  interactionStatus: string;
  // Whether the classifier returned a 'spam' verdict. Anything else
  // (ham / borderline) is NEVER auto-ignored — borderline is surfaced for
  // human review, not dropped.
  isSpam: boolean;
}

export interface SpamIgnoreGateDecision {
  // true → we may auto-ignore (flip in live, audit-only in shadow).
  ignore: boolean;
  // Set iff ignore=false — the first failing condition, fail-closed order.
  reason: SpamIgnoreBlockReason | null;
}

// The spam-ignore gating decision. Evaluated in fail-closed priority order:
// the most decisive "stop" wins. PURE + exhaustively unit-testable — the
// whole point for an action that hides messages from the operator.
export function evaluateSpamIgnoreGate(
  input: SpamIgnoreGateInput,
): SpamIgnoreGateDecision {
  // 1. Hard stop first — the shared kill switch overrides everything.
  if (input.killSwitch) return { ignore: false, reason: "kill_switch" };

  // 2. Channel must be in the shippable set (X/Bluesky/LinkedIn).
  if (!isAutoReplyChannel(input.channel)) {
    return { ignore: false, reason: "channel_unsupported" };
  }

  // 3. The feature must be explicitly engaged for the workspace.
  if (input.spamIgnoreEnabled !== true) {
    return { ignore: false, reason: "not_opted_in" };
  }

  // 4. Existing trust model must be on — but ONLY for live (flipping) mode.
  // Shadow audits + never flips, so it bypasses the trust bar: the whole
  // point of shadow is to preview what we'd ignore before trusting it.
  if (input.isLive && input.trustMode !== true) {
    return { ignore: false, reason: "not_trusted" };
  }

  // 5. Only fresh, un-actioned inbound items are auto-ignore-eligible.
  if (input.interactionStatus !== "unread") {
    return { ignore: false, reason: "already_actioned" };
  }

  // 6. Only a confident 'spam' verdict is eligible — ham + borderline never
  // auto-ignore. This is the conservative core: borderline goes to review.
  if (input.isSpam !== true) {
    return { ignore: false, reason: "not_spam" };
  }

  return { ignore: true, reason: null };
}
