"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { getActiveWorkspaceOrRedirect, getAuthedUserOrRedirect } from "@/lib/workspace";
import {
  isAutoReplyChannel,
  ENGAGEMENT_MODES,
  type EngagementMode,
  evaluateDmCaptureEnableGate,
  type DmCaptureEnableBlockReason,
} from "@/lib/interactions/auto-reply/policy";
import {
  parseLeadRuleForm,
  type LeadRuleFormInput,
} from "@/lib/interactions/auto-reply/lead-rule-input";
import type { Json } from "@/lib/db/types";

type ActionResult = { error: string | null };
// Field-keyed errors for the lead-rule editor (e.g. { link: "..." }), or a
// single top-level `error`. The editor renders whichever is present.
type FieldActionResult = { error: string | null; fieldErrors?: Record<string, string> };
const uuid = z.string().uuid();
const engagementMode = z.enum(ENGAGEMENT_MODES);

// Human copy for each settings-time DM-capture enable block reason. Keeps the
// (pure, testable) gate decoupled from the UI strings.
const DM_CAPTURE_BLOCK_COPY: Record<DmCaptureEnableBlockReason, string> = {
  not_connected: "Account isn't connected.",
  channel_unsupported:
    "Comment→DM is only available on X, Bluesky, and LinkedIn.",
  not_trusted: "Turn on trust mode first — comment→DM builds on it.",
};

export async function setTrustModeAction(
  accountId: string,
  enable: boolean,
): Promise<ActionResult> {
  if (!uuid.safeParse(accountId).success) return { error: "Bad account id." };
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();

  // Eligibility check on enable.
  if (enable) {
    const { data: acct } = await supabase
      .from("social_accounts_safe")
      .select("successful_post_count, trust_threshold")
      .eq("id", accountId)
      .eq("workspace_id", ws.id)
      .maybeSingle();
    if (!acct) return { error: "Account not found." };
    if (acct.successful_post_count < acct.trust_threshold) {
      return { error: "Not yet eligible — need more successful posts." };
    }
  }

  const { error } = await supabase
    .from("social_accounts")
    .update({ trust_mode: enable })
    .eq("id", accountId)
    .eq("workspace_id", ws.id);
  if (error) return { error: error.message };

  // Safety: turning OFF the publishing trust model must also disable BOTH
  // riskier autonomous behaviours that build on it — auto-reply (045) AND
  // comment→DM (046). We never engage (even in shadow) on an account whose
  // trust was just revoked. Reset BOTH tri-state modes (the source of truth,
  // migration 048) AND the legacy booleans so every reader stays in sync.
  if (!enable) {
    await supabase
      .from("social_accounts")
      .update({
        auto_reply_mode: "off",
        auto_reply_enabled: false,
        dm_capture_mode: "off",
        dm_capture_enabled: false,
      })
      .eq("id", accountId)
      .eq("workspace_id", ws.id);
  }

  revalidatePath(`/settings/channels/${accountId}`);
  revalidatePath("/dashboard");
  return { error: null };
}

// Bet 4 (migration 048) — set the per-account auto-reply MODE (tri-state):
//   * 'off'    — feature does nothing for this account.
//   * 'shadow' — drafts + audits what it WOULD reply, but NEVER posts and
//                NEVER flips the interaction. The safe review state.
//   * 'live'   — drafts AND auto-sends public replies at named people, no
//                human in the loop — the riskiest thing this product does.
// Engaging (shadow OR live) requires the existing publishing trust model
// (trust_mode) ON, and only applies to the shippable channels (X / Bluesky /
// LinkedIn). Going to 'off' is always allowed. We write BOTH the tri-state
// column (source of truth) AND the legacy auto_reply_enabled boolean (kept in
// sync: true iff mode='live') so any reader of either stays consistent.
export async function setAutoReplyModeAction(
  accountId: string,
  mode: EngagementMode,
): Promise<ActionResult> {
  if (!uuid.safeParse(accountId).success) return { error: "Bad account id." };
  if (!engagementMode.safeParse(mode).success) return { error: "Bad mode." };
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();

  // Engaging (shadow OR live) requires a connected, supported channel; going
  // 'off' is always allowed. Trust mode is required ONLY for 'live' — shadow
  // sends nothing (zero blast radius), so it's reachable without the trust bar
  // to let the user preview the AI's output before earning trust. Mirrors the
  // gate in policy.evaluateAutoReplyGate (isLive branch).
  if (mode !== "off") {
    const { data: acct } = await supabase
      .from("social_accounts")
      .select("channel, trust_mode, status")
      .eq("id", accountId)
      .eq("workspace_id", ws.id)
      .maybeSingle();
    if (!acct) return { error: "Account not found." };
    if (acct.status !== "connected") {
      return { error: "Account isn't connected." };
    }
    if (!isAutoReplyChannel(acct.channel)) {
      return {
        error: "Auto-reply is only available on X, Bluesky, and LinkedIn.",
      };
    }
    if (mode === "live" && acct.trust_mode !== true) {
      return {
        error: "Turn on trust mode first — going live builds on it. (Shadow works now.)",
      };
    }
  }

  const { error } = await supabase
    .from("social_accounts")
    .update({ auto_reply_mode: mode, auto_reply_enabled: mode === "live" })
    .eq("id", accountId)
    .eq("workspace_id", ws.id);
  if (error) return { error: error.message };

  revalidatePath(`/settings/channels/${accountId}`);
  return { error: null };
}

// Bet 4 (046 + 048) — set the per-account comment→DM MODE (tri-state):
//   * 'off'    — comment→DM does nothing for this account.
//   * 'shadow' — drafts + audits the DM it WOULD send (outcome='shadow' with
//                would_send_text), but NEVER DMs, NEVER tags a lead, NEVER flips
//                the interaction. The safe review state.
//   * 'live'   — drafts AND auto-sends a private DM to a stranger, no human in
//                the loop.
// Engaging (shadow OR live) is gated by the same pure evaluateDmCaptureEnableGate
// (connected + trust_mode + shippable channel), and only applies to X / Bluesky /
// LinkedIn. dm_capture_mode is INDEPENDENT of auto_reply_mode. Going 'off' is
// always allowed. We write BOTH the tri-state column (source of truth — this is
// what dm-send.ts reads) AND the legacy dm_capture_enabled boolean (kept in sync:
// true iff mode='live') so any reader of either stays consistent.
export async function setDmCaptureModeAction(
  accountId: string,
  mode: EngagementMode,
): Promise<ActionResult> {
  if (!uuid.safeParse(accountId).success) return { error: "Bad account id." };
  if (!engagementMode.safeParse(mode).success) return { error: "Bad mode." };
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();

  if (mode !== "off") {
    const { data: acct } = await supabase
      .from("social_accounts")
      .select("channel, trust_mode, status")
      .eq("id", accountId)
      .eq("workspace_id", ws.id)
      .maybeSingle();
    if (!acct) return { error: "Account not found." };
    const gate = evaluateDmCaptureEnableGate({
      channel: acct.channel,
      status: acct.status,
      trustMode: acct.trust_mode === true,
      // Trust required only to go live; shadow previews without sending.
      requireTrust: mode === "live",
    });
    if (!gate.ok && gate.reason) {
      return { error: DM_CAPTURE_BLOCK_COPY[gate.reason] };
    }
  }

  const { error } = await supabase
    .from("social_accounts")
    .update({ dm_capture_mode: mode, dm_capture_enabled: mode === "live" })
    .eq("id", accountId)
    .eq("workspace_id", ws.id);
  if (error) return { error: error.message };

  revalidatePath(`/settings/channels/${accountId}`);
  return { error: null };
}

// Bet 4 (046) — set (or CLEAR) the per-account comment→DM keyword rule. The raw
// settings-form input is validated at the boundary by parseLeadRuleForm (zod):
//   * an entirely empty form CLEARS the rule → we write NULL (the comment→DM
//     path then no-ops by design),
//   * a partial/invalid form returns field errors (we persist nothing),
//   * a valid form is normalised to { keywords[], link, valueCents?, message? }.
// Enabling the rule does NOT auto-send anything; this is config only. Allowed
// regardless of trust/opt-in state (you can prep the rule before enabling), but
// it never fires unless dm_capture_enabled + trust_mode are also on.
export async function setLeadKeywordRuleAction(
  accountId: string,
  form: LeadRuleFormInput,
): Promise<FieldActionResult> {
  if (!uuid.safeParse(accountId).success) return { error: "Bad account id." };
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();

  const parsed = parseLeadRuleForm(form);
  if (!parsed.ok) {
    return { error: "Fix the highlighted fields.", fieldErrors: parsed.errors };
  }

  // Confirm the account exists in this workspace (and is a shippable channel)
  // before writing — same posture as the toggle actions.
  const { data: acct } = await supabase
    .from("social_accounts")
    .select("channel")
    .eq("id", accountId)
    .eq("workspace_id", ws.id)
    .maybeSingle();
  if (!acct) return { error: "Account not found." };
  if (!isAutoReplyChannel(acct.channel)) {
    return {
      error: "Comment→DM is only available on X, Bluesky, and LinkedIn.",
    };
  }

  // null rule → NULL column (path no-ops); otherwise the normalised blob.
  const { error } = await supabase
    .from("social_accounts")
    .update({ lead_keyword_rule: (parsed.rule as Json | null) ?? null })
    .eq("id", accountId)
    .eq("workspace_id", ws.id);
  if (error) return { error: error.message };

  revalidatePath(`/settings/channels/${accountId}`);
  return { error: null };
}

// Bet 4 — the workspace-wide KILL SWITCH. When engaged (kill=true), NO
// account in the workspace auto-sends, regardless of per-account opt-in.
// Stored as workspaces.auto_reply_kill_switch. Always allowed in both
// directions; this is a safety lever, never gated.
export async function setAutoReplyKillSwitchAction(
  kill: boolean,
): Promise<ActionResult> {
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();
  const { error } = await supabase
    .from("workspaces")
    .update({ auto_reply_kill_switch: kill })
    .eq("id", ws.id);
  if (error) return { error: error.message };

  revalidatePath("/settings/channels");
  revalidatePath("/inbox");
  revalidatePath("/dashboard");
  return { error: null };
}

// Disconnect a connected channel. Soft state, not a hard delete: posts
// reference social_accounts with `on delete restrict`, so removing a row a
// workspace has posted through is impossible (and would orphan history). We
// flip status to 'disconnected' and wipe the stored credentials so we hold no
// live tokens for an account the user has cut off. The dispatcher/cron only
// act on status='connected', and the channels listing + quota exclude
// 'disconnected', so the slot frees up. Reconnecting (the OAuth/app-password
// upsert) flips status back to 'connected' and restores credentials.
export async function disconnectAccountAction(accountId: string): Promise<ActionResult> {
  if (!uuid.safeParse(accountId).success) return { error: "Bad account id." };
  const ws = await getActiveWorkspaceOrRedirect();
  const svc = supabaseService();

  // Scope the write to the active workspace so a user can't disconnect another
  // workspace's account by guessing an id. Confirm the row exists + belongs
  // here before mutating.
  const { data: acct } = await svc
    .from("social_accounts")
    .select("id")
    .eq("id", accountId)
    .eq("workspace_id", ws.id)
    .maybeSingle();
  if (!acct) return { error: "Account not found." };

  const { error } = await svc
    .from("social_accounts")
    .update({ status: "disconnected", trust_mode: false, credentials: {} })
    .eq("id", accountId)
    .eq("workspace_id", ws.id);
  if (error) return { error: error.message };

  revalidatePath("/settings/channels");
  revalidatePath(`/settings/channels/${accountId}`);
  revalidatePath("/dashboard");
  return { error: null };
}

// Resets the trust counter for the channel and forces trust_mode back to false.
// Called when the user flags a posted post as "should not have posted" — one strike,
// you lose autopilot until you re-earn it.
export async function flagPostAsRegrettableAction(postId: string): Promise<ActionResult> {
  if (!uuid.safeParse(postId).success) return { error: "Bad post id." };
  const ws = await getActiveWorkspaceOrRedirect();
  const user = await getAuthedUserOrRedirect();
  const svc = supabaseService();

  const { data: post } = await svc
    .from("posts")
    .select("id, social_account_id, workspace_id, status")
    .eq("id", postId)
    .eq("workspace_id", ws.id)
    .maybeSingle();
  if (!post) return { error: "Post not found." };
  if (post.status !== "posted") return { error: "Only posted items can be flagged." };

  const { error: acctErr } = await svc
    .from("social_accounts")
    .update({ trust_mode: false, successful_post_count: 0 })
    .eq("id", post.social_account_id);
  if (acctErr) return { error: acctErr.message };

  await svc.from("approvals").insert({
    post_id: postId,
    user_id: user.id,
    action: "unapproved",
    diff: "flagged: should not have posted",
  });

  revalidatePath(`/settings/channels/${post.social_account_id}`);
  revalidatePath("/dashboard");
  return { error: null };
}
