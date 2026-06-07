// Bet 4 — comment→DM lead capture: the DM ORCHESTRATOR.
//
// =======================================================================
// Wires the pieces together for ONE freshly-polled interaction, mirroring
// auto-reply/send.ts so the two autonomous-community paths share a posture:
//
//   1. Parse the account's keyword→DM rule (migration 046). No rule → hold.
//   2. Match the inbound body against the rule's keywords. No match → hold.
//   3. Evaluate the static DM trust gate (policy.evaluateDmGate): kill switch
//      + channel + trust_mode + dm_capture engaged + rule + match + status.
//      The gate passes identically for 'shadow' and 'live'.
//   4. Enforce the per-platform hourly DM rate cap against dm_capture_log
//      (policy.checkDmRateCap) — stricter than the reply caps. Counts ONLY
//      outcome='sent' rows, so SHADOW rows never consume DM rate budget.
//   5. Build the DM body, then BRANCH on the mode:
//        * 'live'   — dispatch the DM via the per-channel helper, which FIRST
//                     runs a runtime CAPABILITY check (X dm.write / Bluesky
//                     chat / LinkedIn messaging). If the capability is absent
//                     it throws DmScopeMissingError → clean no-op
//                     (outcome='scope_missing'). On success: tag the lead +
//                     audit + flip the interaction to status='read'.
//        * 'shadow' — DO NOT SEND, DO NOT FLIP, DO NOT tag a lead. Audit
//                     outcome='shadow' with the would-send DM text for operator
//                     review. Zero blast radius — no DM helper is ever called.
//
// CRITICAL: this sends PRIVATE messages to strangers. Everything is OFF by
// default; every send is capability-guarded; every attempt is logged; the
// rate caps are conservative. FAIL-CLOSED + FAIL-SAFE: any error is caught,
// recorded, and never poisons the cron run.
// =======================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";
import { DmScopeMissingError } from "../errors";
import {
  evaluateDmGate,
  checkDmRateCap,
  isAutoReplyChannel,
  parseEngagementMode,
  modeEngages,
  modeSends,
  type AutoReplyChannel,
  type DmCaptureBlockReason,
} from "./policy";
import {
  parseLeadKeywordRule,
  matchLeadKeyword,
  buildDmBody,
  tagLeadOutcome,
} from "./lead-capture";
import {
  xSendDm,
  xResolveUsername,
  loadFreshXCredentials,
  type XCredentialsAny,
} from "@/lib/social/x";
import { blueskySendDm, type BlueskyCredentials } from "@/lib/social/bluesky";
import { linkedinSendDm, type LinkedInCredentials } from "@/lib/social/linkedin";

type ServiceClient = SupabaseClient<Database>;
type SocialAccountRow = Database["public"]["Tables"]["social_accounts"]["Row"];
type InteractionRow = Database["public"]["Tables"]["interactions"]["Row"];

// 'shadow' — drafted + audited but DID NOT send a DM, tag a lead, or flip.
export type DmCaptureOutcome =
  | "sent"
  | "shadow"
  | "blocked"
  | "failed"
  | "scope_missing";

export interface DmCaptureRunResult {
  interactionId: string;
  outcome: DmCaptureOutcome;
  reason: DmCaptureBlockReason | string | null;
  matchedKeyword: string | null;
  externalId: string | null;
  leadTagged: boolean;
}

// Attempt one comment→DM lead capture. All DB access goes through `svc`; the
// gate/rate-cap decisions are delegated to the pure policy module; the runtime
// capability check lives in the per-channel send helper. Always resolves
// (never throws) — every outcome is recorded.
export async function attemptLeadCaptureDm(
  svc: ServiceClient,
  account: SocialAccountRow,
  interaction: InteractionRow,
  killSwitch: boolean,
  now: Date = new Date(),
): Promise<DmCaptureRunResult> {
  const channel = interaction.channel;

  // Tri-state mode (migration 048) is the source of truth. The legacy boolean
  // is kept in sync (live ⇒ enabled=true); we resolve the MODE here so the
  // shadow branch is decided from a single typed value. Fail-closed: an absent
  // / unknown mode parses to 'off'.
  const mode = parseEngagementMode(account.dm_capture_mode);
  const engaged = modeEngages(mode); // shadow OR live

  // ── Rule + keyword match (computed up front; feeds the gate) ─────────
  const rule = parseLeadKeywordRule(account.lead_keyword_rule);
  const matchedKeyword = rule ? matchLeadKeyword(interaction.body, rule) : null;

  // ── Static trust gate ────────────────────────────────────────────────
  // Shadow and live ENGAGE identically here — only AFTER building the DM body
  // do we branch on send-vs-shadow.
  const gate = evaluateDmGate({
    channel,
    trustMode: account.trust_mode === true,
    dmCaptureEnabled: engaged,
    isLive: modeSends(mode), // trust required only for live; shadow previews freely
    killSwitch,
    hasRule: rule !== null,
    keywordMatched: matchedKeyword !== null,
    interactionStatus: interaction.status,
  });
  if (!gate.send) {
    // Don't spam the audit log with the boring steady-state rejections (not
    // opted in / wrong channel / no rule / no keyword match) for accounts that
    // haven't configured the feature. Only log a HELD decision when the
    // account is actually opted in AND a keyword matched — i.e. an
    // active-but-held state an operator would want to see.
    const worthLogging =
      account.trust_mode === true &&
      engaged &&
      matchedKeyword !== null &&
      isAutoReplyChannel(channel);
    if (worthLogging) {
      await recordLog(svc, {
        workspaceId: interaction.workspace_id,
        accountId: account.id,
        interactionId: interaction.id,
        channel: channel as AutoReplyChannel,
        outcome: "blocked",
        reason: gate.reason,
        matchedKeyword,
        dmText: "(no DM sent — gate held)",
        externalId: null,
        leadTagged: false,
      });
    }
    return {
      interactionId: interaction.id,
      outcome: "blocked",
      reason: gate.reason,
      matchedKeyword,
      externalId: null,
      leadTagged: false,
    };
  }

  // Past the gate: channel is an AutoReplyChannel, rule + matchedKeyword exist.
  const ch = channel as AutoReplyChannel;
  const usableRule = rule!;
  const keyword = matchedKeyword!;

  // ── Rate cap (LIVE only; stricter than replies) ──────────────────────
  // Bounds how many auto-DMs HIT THE PLATFORM per hour. Shadow never messages
  // anyone, so it is intentionally UNLIMITED — skip the cap for non-live modes.
  if (modeSends(mode)) {
    const sentTimestamps = await loadRecentSentTimestamps(svc, account.id, now);
    const rate = checkDmRateCap(ch, sentTimestamps, now.valueOf());
    if (!rate.allowed) {
      await recordLog(svc, {
        workspaceId: interaction.workspace_id,
        accountId: account.id,
        interactionId: interaction.id,
        channel: ch,
        outcome: "blocked",
        reason: "rate_capped",
        matchedKeyword: keyword,
        dmText: `(rate capped — ${rate.used}/${rate.cap} DMs this hour)`,
        externalId: null,
        leadTagged: false,
      });
      return {
        interactionId: interaction.id,
        outcome: "blocked",
        reason: "rate_capped",
        matchedKeyword: keyword,
        externalId: null,
        leadTagged: false,
      };
    }
  }

  // ── Build the DM body ────────────────────────────────────────────────
  const dmText = buildDmBody(usableRule);

  // ── SHADOW branch (zero blast radius) ────────────────────────────────
  // SAFETY-CRITICAL: when the mode is not 'live' we MUST NOT message anyone,
  // MUST NOT tag a lead, and MUST NOT flip the interaction. We audit
  // outcome='shadow' with the would-send DM text and return. modeSends(mode)
  // is the single predicate that authorises a real DM; shadow short-circuits
  // BEFORE the dispatchDmViaChannel call below is ever reached.
  if (!modeSends(mode)) {
    await recordLog(svc, {
      workspaceId: interaction.workspace_id,
      accountId: account.id,
      interactionId: interaction.id,
      channel: ch,
      outcome: "shadow",
      reason: keyword,
      matchedKeyword: keyword,
      dmText, // the exact DM we WOULD have sent — for operator review
      externalId: null,
      leadTagged: false,
    });
    // Deliberately NO interactions update — the row stays 'unread' so the
    // operator still sees the suggestion and a later flip to 'live' can act.
    return {
      interactionId: interaction.id,
      outcome: "shadow",
      reason: keyword,
      matchedKeyword: keyword,
      externalId: null,
      leadTagged: false,
    };
  }

  // ── LIVE: Send (runtime capability check inside the per-channel helper) ─
  let externalId: string;
  try {
    externalId = await dispatchDmViaChannel(svc, account, interaction, dmText);
  } catch (err) {
    if (err instanceof DmScopeMissingError) {
      // Capability/scope absent → clean, audited NO-OP. Never a failure.
      await recordLog(svc, {
        workspaceId: interaction.workspace_id,
        accountId: account.id,
        interactionId: interaction.id,
        channel: ch,
        outcome: "scope_missing",
        reason: err.scope,
        matchedKeyword: keyword,
        dmText,
        externalId: null,
        leadTagged: false,
      });
      return {
        interactionId: interaction.id,
        outcome: "scope_missing",
        reason: err.scope,
        matchedKeyword: keyword,
        externalId: null,
        leadTagged: false,
      };
    }
    const reason = `dm_send_failed: ${err instanceof Error ? err.message : "unknown"}`.slice(0, 500);
    await recordLog(svc, {
      workspaceId: interaction.workspace_id,
      accountId: account.id,
      interactionId: interaction.id,
      channel: ch,
      outcome: "failed",
      reason,
      matchedKeyword: keyword,
      dmText,
      externalId: null,
      leadTagged: false,
    });
    return {
      interactionId: interaction.id,
      outcome: "failed",
      reason,
      matchedKeyword: keyword,
      externalId: null,
      leadTagged: false,
    };
  }

  // ── Tag the lead (defensive) ─────────────────────────────────────────
  const leadTagged = await tagLeadOutcome(svc, {
    workspaceId: interaction.workspace_id,
    postId: interaction.parent_post_id,
    matchedKeyword: keyword,
    valueCents: usableRule.valueCents ?? 0,
    note: `Auto-DM lead capture (matched "${keyword}") via ${ch}`,
  });

  // ── Audit + flip interaction to actioned ─────────────────────────────
  await recordLog(svc, {
    workspaceId: interaction.workspace_id,
    accountId: account.id,
    interactionId: interaction.id,
    channel: ch,
    outcome: "sent",
    reason: keyword,
    matchedKeyword: keyword,
    dmText,
    externalId,
    leadTagged,
  });

  // Mark the interaction read so neither the auto-reply pass nor a later DM
  // pass re-actions it. We do NOT set status='replied' (that's the public
  // reply path's semantic); a DM isn't a thread reply.
  await svc
    .from("interactions")
    .update({ status: "read" })
    .eq("id", interaction.id);

  return {
    interactionId: interaction.id,
    outcome: "sent",
    reason: keyword,
    matchedKeyword: keyword,
    externalId,
    leadTagged,
  };
}

// ── Per-channel DM dispatch ───────────────────────────────────────────────
//
// Returns the platform-native id of the sent DM/conversation. Throws
// DmScopeMissingError when the account lacks DM capability (caught by the
// orchestrator as a no-op), or a generic Error on a real send failure.
async function dispatchDmViaChannel(
  svc: ServiceClient,
  account: SocialAccountRow,
  interaction: InteractionRow,
  dmText: string,
): Promise<string> {
  switch (interaction.channel) {
    case "x": {
      const rawCreds = account.credentials as unknown as XCredentialsAny;
      const creds = await loadFreshXCredentials(svc, account.id, rawCreds);
      // The X DM endpoint needs the recipient's numeric user id; our row stores
      // the @username. Resolve it. A resolution failure is a real failure
      // (not a scope miss) — surface it.
      const resolved = await xResolveUsername(creds, interaction.author_handle);
      const r = await xSendDm(creds, resolved.id, dmText);
      return r.id;
    }
    case "bluesky": {
      const creds = account.credentials as unknown as BlueskyCredentials;
      // author_handle is the Bluesky handle (resolved to a DID inside the
      // helper). The capability probe + send both live in blueskySendDm.
      const r = await blueskySendDm(creds, interaction.author_handle, dmText);
      return r.id;
    }
    case "linkedin": {
      const creds = account.credentials as unknown as LinkedInCredentials;
      // author_handle is the author's person URN. linkedinSendDm throws
      // DmScopeMissingError today (messaging is partnership-gated) → no-op.
      const r = await linkedinSendDm(creds, interaction.author_handle, dmText);
      return r.id;
    }
    default:
      // x / bluesky / linkedin are the only comment→DM channels; the gate
      // rejects everything else before we get here.
      throw new Error(`Channel not supported by DM send: ${interaction.channel}`);
  }
}

// ── helpers ─────────────────────────────────────────────────────────────

async function loadRecentSentTimestamps(
  svc: ServiceClient,
  accountId: string,
  now: Date,
): Promise<number[]> {
  // Look back a touch over the 1h window so clock skew never undercounts.
  const since = new Date(now.valueOf() - 2 * 60 * 60 * 1000).toISOString();
  const { data } = await svc
    .from("dm_capture_log")
    .select("created_at")
    .eq("social_account_id", accountId)
    .eq("outcome", "sent")
    .gte("created_at", since);
  return (data ?? [])
    .map((r) => new Date(r.created_at).valueOf())
    .filter((t) => Number.isFinite(t));
}

interface DmLogInput {
  workspaceId: string;
  accountId: string;
  interactionId: string;
  channel: AutoReplyChannel;
  outcome: DmCaptureOutcome;
  reason: string | null;
  matchedKeyword: string | null;
  dmText: string;
  externalId: string | null;
  leadTagged: boolean;
}

async function recordLog(svc: ServiceClient, input: DmLogInput): Promise<void> {
  // dm_text CHECK requires length 1..3000; never let a placeholder violate it.
  const text =
    input.dmText.trim().length > 0 ? input.dmText.slice(0, 3000) : "(none)";
  // For SHADOW rows, also surface the draft in the dedicated, reviewable
  // would_send_text column (migration 048) — non-shadow rows leave it null.
  const wouldSend =
    input.outcome === "shadow" && input.dmText.trim().length > 0
      ? input.dmText.slice(0, 3000)
      : null;
  const { error } = await svc.from("dm_capture_log").insert({
    workspace_id: input.workspaceId,
    social_account_id: input.accountId,
    interaction_id: input.interactionId,
    channel: input.channel,
    outcome: input.outcome,
    outcome_reason: input.reason,
    matched_keyword: input.matchedKeyword,
    dm_text: text,
    would_send_text: wouldSend,
    external_id: input.externalId,
    lead_tagged: input.leadTagged,
  });
  if (error) {
    console.warn("[dm-capture] failed to write audit log:", error.message);
  }
}
