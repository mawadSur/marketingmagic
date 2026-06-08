// TODO #0 (gap 1) — the SPAM-IGNORE ORCHESTRATOR.
//
// =======================================================================
// Wires the pieces together for ONE freshly-polled interaction:
//
//   1. Classify the body with the cheap pure heuristics (spam.ts).
//   2. If the workspace opted into Claude AND the heuristic verdict is the
//      grey 'borderline' band, escalate to Claude (fail-open toward ham).
//   3. Persist the resolved spam_score back onto the interaction row.
//   4. Evaluate the static spam-ignore gate (trust + mode + kill switch +
//      status + spam verdict). The gate passes identically for shadow/live;
//      only AFTER do we branch on flip-vs-audit.
//   5. Branch on the mode:
//        * 'live'   — audit outcome='ignored', flip status → 'ignored'.
//        * 'shadow' — DO NOT FLIP. Audit outcome='shadow' with the verdict +
//                     signals so an operator can review what we WOULD ignore.
//   6. Record EVERY actionable decision in spam_ignore_log.
//
// Called from poll-interactions BEFORE the DM + auto-reply passes, so a row
// classified as spam is dropped before we ever consider replying to it.
//
// FAIL-CLOSED + FAIL-SAFE: any classification/DB error is caught, recorded
// (best-effort), and the interaction is LEFT VISIBLE for human review. One
// bad row never poisons the run, and an error never hides a message.
// =======================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, EngagementMode } from "@/lib/db/types";
import {
  classifySpamHeuristic,
  classifyBorderlineWithClaude,
  type SpamClassification,
} from "../spam";
import {
  evaluateSpamIgnoreGate,
  type SpamIgnoreBlockReason,
} from "./spam-policy";
import { parseEngagementMode, modeEngages, modeSends } from "./policy";

type ServiceClient = SupabaseClient<Database>;
type SocialAccountRow = Database["public"]["Tables"]["social_accounts"]["Row"];
type InteractionRow = Database["public"]["Tables"]["interactions"]["Row"];

// Workspace-level spam-ignore context, loaded once per workspace and cached
// by the caller across a cron run.
export interface SpamIgnoreContext {
  // Tri-state: off | shadow | live (workspaces.spam_ignore_mode). Default off.
  mode: EngagementMode;
  // Whether to escalate the borderline band to Claude (workspaces
  // .spam_ignore_use_claude). Default false — heuristics only.
  useClaude: boolean;
  // Reuses the auto-reply kill switch — one "stop everything" lever.
  killSwitch: boolean;
}

export interface SpamIgnoreRunResult {
  // 'ignored' — flipped to status='ignored' (live).
  // 'shadow'  — would-ignore audited, row left visible.
  // 'kept'    — classified ham/borderline (or gate held); nothing done.
  // 'failed'  — an error; row left visible for human review.
  outcome: "ignored" | "shadow" | "kept" | "failed";
  interactionId: string;
  reason: SpamIgnoreBlockReason | string | null;
  spamScore: number;
}

// Attempt one spam-ignore. All DB access goes through `svc`; the
// classify/gate decisions are delegated to the pure spam + spam-policy
// modules. Always resolves (never throws) — failures are recorded.
export async function attemptSpamIgnore(
  svc: ServiceClient,
  account: SocialAccountRow,
  interaction: InteractionRow,
  ctx: SpamIgnoreContext,
  now: Date = new Date(),
): Promise<SpamIgnoreRunResult> {
  const channel = interaction.channel;
  const mode = ctx.mode;
  const engaged = modeEngages(mode); // shadow OR live
  const live = modeSends(mode);

  // ── Classify ─────────────────────────────────────────────────────────
  // Cheap heuristics first. Always runs even when the feature is 'off' so we
  // can persist a spam_score for the inbox to sort/surface by — but an 'off'
  // workspace NEVER flips a row (the gate below blocks on not_opted_in).
  let classification: SpamClassification;
  try {
    classification = classifySpamHeuristic(interaction.body);
    // Escalate ONLY the grey band to Claude, and ONLY when the workspace is
    // both engaged and opted into Claude — never spend a token for an 'off'
    // workspace or a clear ham/spam heuristic verdict.
    if (engaged && ctx.useClaude && classification.verdict === "borderline") {
      const claude = await classifyBorderlineWithClaude(
        interaction.body,
        classification,
      );
      classification = claude.classification;
    }
  } catch (err) {
    // Classification should never throw (heuristics are pure; Claude fails
    // open), but be safe: leave the row visible.
    return {
      interactionId: interaction.id,
      outcome: "failed",
      reason: `classify_failed: ${err instanceof Error ? err.message : "unknown"}`,
      spamScore: 0,
    };
  }

  // Persist the score regardless of mode (best-effort; failure is non-fatal).
  // This powers the inbox "spam" sort/surface even in 'off' workspaces.
  await persistScore(svc, interaction.id, classification.score);

  // ── Static gate ────────────────────────────────────────────────────────
  const gate = evaluateSpamIgnoreGate({
    channel,
    trustMode: account.trust_mode === true,
    spamIgnoreEnabled: engaged,
    isLive: live,
    killSwitch: ctx.killSwitch,
    interactionStatus: interaction.status,
    isSpam: classification.verdict === "spam",
  });
  if (!gate.ignore) {
    // Don't spam the audit log with steady-state rejections (off / wrong
    // channel / not-spam). Only log a HELD decision when the workspace is
    // actively engaged AND we genuinely wanted to ignore (a spam verdict that
    // a guard blocked — kill switch / not-trusted), so a configured operator
    // can see why a clear-spam row was NOT dropped.
    const wantedToIgnore = classification.verdict === "spam";
    const worthLogging =
      engaged &&
      wantedToIgnore &&
      (gate.reason === "kill_switch" || gate.reason === "not_trusted");
    if (worthLogging) {
      await recordLog(svc, {
        workspaceId: interaction.workspace_id,
        accountId: account.id,
        interactionId: interaction.id,
        channel,
        outcome: "blocked",
        reason: gate.reason,
        classification,
      });
    }
    return {
      interactionId: interaction.id,
      outcome: "kept",
      reason: gate.reason,
      spamScore: classification.score,
    };
  }

  // Past the gate, the verdict is 'spam' and the channel is shippable.

  // ── SHADOW branch (zero blast radius) ────────────────────────────────────
  // SAFETY-CRITICAL: when not live we MUST NOT flip the interaction. We audit
  // outcome='shadow' with the verdict + signals and leave the row VISIBLE.
  if (!live) {
    await recordLog(svc, {
      workspaceId: interaction.workspace_id,
      accountId: account.id,
      interactionId: interaction.id,
      channel,
      outcome: "shadow",
      reason: null,
      classification,
    });
    return {
      interactionId: interaction.id,
      outcome: "shadow",
      reason: null,
      spamScore: classification.score,
    };
  }

  // ── LIVE: audit + flip the interaction to 'ignored' ──────────────────────
  await recordLog(svc, {
    workspaceId: interaction.workspace_id,
    accountId: account.id,
    interactionId: interaction.id,
    channel,
    outcome: "ignored",
    reason: null,
    classification,
  });

  const { error: flipErr } = await svc
    .from("interactions")
    .update({ status: "ignored", priority_score: 0 })
    .eq("id", interaction.id);
  if (flipErr) {
    // Audited as ignored but the flip failed — record a failure and leave the
    // row visible. The audit row above still documents the intent.
    return {
      interactionId: interaction.id,
      outcome: "failed",
      reason: `flip_failed: ${flipErr.message}`.slice(0, 500),
      spamScore: classification.score,
    };
  }

  return {
    interactionId: interaction.id,
    outcome: "ignored",
    reason: null,
    spamScore: classification.score,
  };
}

// ── helpers ─────────────────────────────────────────────────────────────

async function persistScore(
  svc: ServiceClient,
  interactionId: string,
  score: number,
): Promise<void> {
  const { error } = await svc
    .from("interactions")
    .update({ spam_score: score })
    .eq("id", interactionId);
  if (error) {
    console.warn("[spam-ignore] failed to persist spam_score:", error.message);
  }
}

interface LogInput {
  workspaceId: string;
  accountId: string;
  interactionId: string;
  channel: string;
  outcome: "ignored" | "shadow" | "blocked";
  reason: string | null;
  classification: SpamClassification;
}

async function recordLog(svc: ServiceClient, input: LogInput): Promise<void> {
  // Compact, human-readable signal summary for the audit/review UI. Bounded
  // to the column CHECK ceiling.
  const signalSummary =
    input.classification.signals.length > 0
      ? input.classification.signals.map((s) => `${s.key}: ${s.note}`).join("; ").slice(0, 1000)
      : "(no heuristic signals)";
  const { error } = await svc.from("spam_ignore_log").insert({
    workspace_id: input.workspaceId,
    social_account_id: input.accountId,
    interaction_id: input.interactionId,
    channel: input.channel,
    outcome: input.outcome,
    outcome_reason: input.reason,
    spam_score: input.classification.score,
    verdict: input.classification.verdict,
    signal_summary: signalSummary,
  });
  if (error) {
    console.warn("[spam-ignore] failed to write audit log:", error.message);
  }
}
