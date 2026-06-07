// Bet 4 — Autonomous Community Engagement: the auto-reply ORCHESTRATOR.
//
// =======================================================================
// Wires the pieces together for ONE freshly-polled interaction:
//
//   1. Load gate state (workspace kill switch + account trust_mode +
//      auto_reply_mode).
//   2. Evaluate the static trust gate (policy.evaluateAutoReplyGate). The gate
//      passes identically for 'shadow' and 'live' — both ENGAGE.
//   3. Enforce the per-platform hourly rate cap against auto_reply_log
//      (policy.checkRateCap). Counts ONLY outcome='sent' rows, so SHADOW rows
//      never consume rate budget (shadow is unlimited — it never hits the
//      platform).
//   4. Draft a reply in brand voice (reuse interactions/draft-reply).
//   5. THEN branch on the mode:
//        * 'live'   — send via the shared per-channel core (send-core), audit
//                     outcome='sent', flip the interaction to status='replied'.
//        * 'shadow' — DO NOT SEND, DO NOT FLIP. Audit outcome='shadow' with the
//                     would-send text so an operator can review it. Zero blast
//                     radius — the channel send call is NEVER reached.
//   6. Record EVERY decision in auto_reply_log — sent / shadow / blocked / failed.
//
// Called from the poll-interactions cron AFTER new rows are persisted, so
// it never invents a new surface. It runs with the service-role client
// (RLS-bypassing) exactly like the rest of the cron.
//
// FAIL-CLOSED + FAIL-SAFE: any error drafting or sending is caught,
// recorded as a 'failed' log row, and the interaction is left as a normal
// suggestion for human review. One bad interaction never poisons the run.
// =======================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, VoiceProfile } from "@/lib/db/types";
import {
  draftReply,
  type ReplyInteractionInput,
  type ReplyWorkspaceContext,
} from "../draft-reply";
import { sendReplyViaChannel } from "../send-core";
import {
  evaluateAutoReplyGate,
  checkRateCap,
  isAutoReplyChannel,
  parseEngagementMode,
  modeEngages,
  modeSends,
  type AutoReplyChannel,
  type AutoReplyBlockReason,
} from "./policy";

type ServiceClient = SupabaseClient<Database>;
type SocialAccountRow = Database["public"]["Tables"]["social_accounts"]["Row"];
type InteractionRow = Database["public"]["Tables"]["interactions"]["Row"];

// Voice context the drafter needs, loaded once per workspace and cached
// by the caller across a cron run.
export interface AutoReplyVoiceContext {
  voiceProfile: VoiceProfile | null;
  voice: string;
  doNotSay: string[];
  productDescription: string;
}

export interface AutoReplyRunResult {
  // 'shadow' — we drafted + audited but DID NOT send and DID NOT flip the row.
  outcome: "sent" | "shadow" | "blocked" | "failed";
  interactionId: string;
  reason: AutoReplyBlockReason | string | null;
  externalId: string | null;
}

// Attempt one autonomous reply. Pure-ish at the edges: all DB access goes
// through `svc`; the gate/rate-cap decisions are delegated to the pure
// policy module. Always resolves (never throws) — failures are recorded.
export async function attemptAutoReply(
  svc: ServiceClient,
  account: SocialAccountRow,
  interaction: InteractionRow,
  killSwitch: boolean,
  voiceCtx: AutoReplyVoiceContext,
  now: Date = new Date(),
): Promise<AutoReplyRunResult> {
  const channel = interaction.channel;

  // Tri-state mode (migration 048) is the source of truth. The legacy boolean
  // is kept in sync (live ⇒ enabled=true), but we resolve the MODE here so the
  // shadow branch is decided from a single typed value. Fail-closed: an absent
  // / unknown mode parses to 'off'.
  const mode = parseEngagementMode(account.auto_reply_mode);
  const engaged = modeEngages(mode); // shadow OR live

  // ── Static trust gate ───────────────────────────────────────────────
  // Shadow and live ENGAGE identically here — the gate is the shared safety
  // core. Only AFTER drafting do we branch on send-vs-shadow.
  const gate = evaluateAutoReplyGate({
    channel,
    trustMode: account.trust_mode === true,
    autoReplyEnabled: engaged,
    isLive: modeSends(mode), // trust required only for live; shadow previews freely
    killSwitch,
    interactionStatus: interaction.status,
    hasDraft: true, // we haven't drafted yet; the drafter result is checked below
  });
  if (!gate.send) {
    // Don't spam the audit log with the boring "not opted in / wrong
    // channel" rejections — those are the steady-state for every account
    // that hasn't turned the feature on. Only log decisions that reflect
    // an active-but-held state (kill switch / rate cap are logged at the
    // call sites below; here we record the rest only when the account is
    // actually opted in, so a configured operator can see why we held).
    const worthLogging = account.trust_mode === true && engaged;
    if (worthLogging && isAutoReplyChannel(channel)) {
      await recordLog(svc, {
        workspaceId: interaction.workspace_id,
        accountId: account.id,
        interactionId: interaction.id,
        channel,
        outcome: "blocked",
        reason: gate.reason,
        replyText: "(no reply drafted — gate held)",
        externalId: null,
        replyPostId: null,
      });
    }
    return {
      interactionId: interaction.id,
      outcome: "blocked",
      reason: gate.reason,
      externalId: null,
    };
  }

  // Past the gate, channel is guaranteed to be an AutoReplyChannel.
  const ch = channel as AutoReplyChannel;

  // ── Rate cap (LIVE only) ─────────────────────────────────────────────
  // The cap bounds how many auto-replies HIT THE PLATFORM per hour. Shadow
  // never posts, so it is intentionally UNLIMITED — we skip the cap entirely
  // for non-live modes. (The cap also only counts outcome='sent' rows, so a
  // shadow row could never consume budget even if we did check.)
  if (modeSends(mode)) {
    const sentTimestamps = await loadRecentSentTimestamps(svc, account.id, now);
    const rate = checkRateCap(ch, sentTimestamps, now.valueOf());
    if (!rate.allowed) {
      await recordLog(svc, {
        workspaceId: interaction.workspace_id,
        accountId: account.id,
        interactionId: interaction.id,
        channel: ch,
        outcome: "blocked",
        reason: "rate_capped",
        replyText: `(rate capped — ${rate.used}/${rate.cap} this hour)`,
        externalId: null,
        replyPostId: null,
      });
      return {
        interactionId: interaction.id,
        outcome: "blocked",
        reason: "rate_capped",
        externalId: null,
      };
    }
  }

  // ── Draft ────────────────────────────────────────────────────────────
  let replyText: string;
  try {
    const input: ReplyInteractionInput = {
      channel: ch,
      author_handle: interaction.author_handle,
      author_display_name: interaction.author_display_name,
      body: interaction.body,
    };
    const ctx: ReplyWorkspaceContext = {
      voiceProfile: voiceCtx.voiceProfile,
      voice: voiceCtx.voice,
      doNotSay: voiceCtx.doNotSay,
      productDescription: voiceCtx.productDescription,
      parentPostText: await loadParentPostText(svc, interaction.parent_post_id),
    };
    const draft = await draftReply(input, ctx);
    replyText = (draft.drafts[0] ?? "").trim();
  } catch (err) {
    return recordFailure(svc, account, interaction, ch, "draft_failed", err);
  }
  if (replyText.length === 0) {
    await recordLog(svc, {
      workspaceId: interaction.workspace_id,
      accountId: account.id,
      interactionId: interaction.id,
      channel: ch,
      outcome: "blocked",
      reason: "empty_draft",
      replyText: "(drafter returned nothing)",
      externalId: null,
      replyPostId: null,
    });
    return {
      interactionId: interaction.id,
      outcome: "blocked",
      reason: "empty_draft",
      externalId: null,
    };
  }
  // Defensive clamp to the audit-column ceiling (matches the manual path's
  // 3000-char limit and the auto_reply_log CHECK).
  if (replyText.length > 3000) replyText = replyText.slice(0, 3000);

  // ── SHADOW branch (zero blast radius) ────────────────────────────────
  // SAFETY-CRITICAL: when the mode is not 'live' we MUST NOT touch the
  // channel and MUST NOT flip the interaction. We audit outcome='shadow'
  // with the would-send text and return. modeSends(mode) is the single
  // predicate that authorises a real send; shadow short-circuits BEFORE the
  // sendReplyViaChannel call below ever appears in the control flow.
  if (!modeSends(mode)) {
    await recordLog(svc, {
      workspaceId: interaction.workspace_id,
      accountId: account.id,
      interactionId: interaction.id,
      channel: ch,
      outcome: "shadow",
      reason: null,
      replyText, // the exact text we WOULD have sent — for operator review
      externalId: null,
      replyPostId: null,
    });
    // Deliberately NO interactions update — the row stays 'unread' so the
    // operator still sees it as a live suggestion and a later flip to 'live'
    // can act on it for real.
    return {
      interactionId: interaction.id,
      outcome: "shadow",
      reason: null,
      externalId: null,
    };
  }

  // ── LIVE: Send ───────────────────────────────────────────────────────
  let externalId: string;
  let replyPostId: string | null;
  try {
    const result = await sendReplyViaChannel(
      svc,
      account,
      {
        id: interaction.id,
        workspace_id: interaction.workspace_id,
        channel: interaction.channel,
        external_id: interaction.external_id,
        parent_post_id: interaction.parent_post_id,
      },
      replyText,
    );
    externalId = result.externalId;
    replyPostId = result.postId;
  } catch (err) {
    return recordFailure(svc, account, interaction, ch, "send_failed", err, replyText);
  }

  // ── LIVE: Audit + flip interaction ───────────────────────────────────
  await recordLog(svc, {
    workspaceId: interaction.workspace_id,
    accountId: account.id,
    interactionId: interaction.id,
    channel: ch,
    outcome: "sent",
    reason: null,
    replyText,
    externalId,
    replyPostId,
  });

  await svc
    .from("interactions")
    .update({
      status: "replied",
      replied_at: now.toISOString(),
      replied_to_post_id: replyPostId,
    })
    .eq("id", interaction.id);

  return {
    interactionId: interaction.id,
    outcome: "sent",
    reason: null,
    externalId,
  };
}

// ── helpers ─────────────────────────────────────────────────────────────

async function loadRecentSentTimestamps(
  svc: ServiceClient,
  accountId: string,
  now: Date,
): Promise<number[]> {
  // Look back a touch over the 1h window so a clock skew never undercounts.
  const since = new Date(now.valueOf() - 2 * 60 * 60 * 1000).toISOString();
  const { data } = await svc
    .from("auto_reply_log")
    .select("created_at")
    .eq("social_account_id", accountId)
    .eq("outcome", "sent")
    .gte("created_at", since);
  return (data ?? [])
    .map((r) => new Date(r.created_at).valueOf())
    .filter((t) => Number.isFinite(t));
}

async function loadParentPostText(
  svc: ServiceClient,
  parentPostId: string | null,
): Promise<string | null> {
  if (!parentPostId) return null;
  const { data } = await svc
    .from("posts")
    .select("text")
    .eq("id", parentPostId)
    .maybeSingle();
  return data?.text ?? null;
}

interface LogInput {
  workspaceId: string;
  accountId: string;
  interactionId: string;
  channel: AutoReplyChannel;
  outcome: "sent" | "shadow" | "blocked" | "failed";
  reason: string | null;
  replyText: string;
  externalId: string | null;
  replyPostId: string | null;
}

async function recordLog(svc: ServiceClient, input: LogInput): Promise<void> {
  // The reply_text CHECK requires length 1..3000; never let an empty
  // placeholder violate it.
  const text =
    input.replyText.trim().length > 0
      ? input.replyText.slice(0, 3000)
      : "(none)";
  // For SHADOW rows, also surface the draft in the dedicated, reviewable
  // would_send_text column (migration 048) — non-shadow rows leave it null.
  const wouldSend =
    input.outcome === "shadow" && input.replyText.trim().length > 0
      ? input.replyText.slice(0, 3000)
      : null;
  const { error } = await svc.from("auto_reply_log").insert({
    workspace_id: input.workspaceId,
    social_account_id: input.accountId,
    interaction_id: input.interactionId,
    channel: input.channel,
    outcome: input.outcome,
    outcome_reason: input.reason,
    reply_text: text,
    would_send_text: wouldSend,
    external_id: input.externalId,
    reply_post_id: input.replyPostId,
  });
  if (error) {
    console.warn("[auto-reply] failed to write audit log:", error.message);
  }
}

async function recordFailure(
  svc: ServiceClient,
  account: SocialAccountRow,
  interaction: InteractionRow,
  channel: AutoReplyChannel,
  kind: string,
  err: unknown,
  replyText?: string,
): Promise<AutoReplyRunResult> {
  const reason = `${kind}: ${err instanceof Error ? err.message : "unknown"}`.slice(0, 500);
  await recordLog(svc, {
    workspaceId: interaction.workspace_id,
    accountId: account.id,
    interactionId: interaction.id,
    channel,
    outcome: "failed",
    reason,
    replyText: replyText ?? "(send failed before/at dispatch)",
    externalId: null,
    replyPostId: null,
  });
  return {
    interactionId: interaction.id,
    outcome: "failed",
    reason,
    externalId: null,
  };
}
