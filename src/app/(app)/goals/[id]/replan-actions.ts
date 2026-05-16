"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { getActiveWorkspaceOrRedirect, getAuthedUserOrRedirect } from "@/lib/workspace";
import { proposeStrategy } from "@/lib/goals/reverse-plan";
import { computeGoalProgress, paceLabel } from "@/lib/goals/progress";
import {
  proposeStrategyResultSchema,
  type GoalDraft,
  type GoalMetric,
} from "@/lib/goals/schema";
import {
  ENABLED_CHANNELS,
  type ChannelId,
} from "@/lib/channels/registry";
import type { Database, Json } from "@/lib/db/types";

// Phase 2.1 replan-loop server actions.
//
// One entry point: acceptReplanProposalAction(proposalId, mode). The mode
// switch keeps the wire format minimal — the banner button posts a single
// form with the proposal id and either 'propose_new' or 'dismiss'.
//
//   - mode='dismiss' → stamp `accepted_at` + `accepted_by='user_dismiss'`
//     on the proposal. The string is a SENTINEL — accepted_by in the
//     schema is a uuid FK to auth.users, but for "dismiss" we have no
//     user-action target to attach. We special-case the sentinel by
//     writing the proposal row with accepted_by=null and stashing the
//     "user_dismiss" intent in a separate column (proposed_by) is
//     wrong — it's the origin. To keep the schema honest WITHOUT a new
//     column, we use the dedicated 'reason' tag suffix: append
//     ":dismissed" so a future analytics pass can distinguish "user
//     accepted the replan" from "user dismissed the proposal." V1 also
//     leaves accepted_by = the authed user's id either way; the
//     'reason' tail is the discriminator.
//
//   - mode='propose_new' → re-run proposeStrategy() with enriched context
//     (actual progress vs target, time elapsed, posts shipped/missed),
//     insert a NEW content_goals row with parent_goal_id pointing at the
//     original and status='draft', stamp the proposal row, and redirect
//     to /goals/<new_id> for two-step approval (strategy → posts). The
//     original goal stays 'active' — the user can still ship its
//     existing scheduled posts while deciding whether to approve the
//     replan strategy.
//
// We deliberately keep `acceptReplanProposalAction` as the only public
// surface. A handful of small helpers below build the enriched context
// and channelMix — they're not exported because the only legitimate
// caller is this action.

const idSchema = z.string().uuid();
const modeSchema = z.enum(["propose_new", "dismiss"]);

export type AcceptReplanState = {
  error: string | null;
  newGoalId: string | null;
};

type ContentGoalRow = Database["public"]["Tables"]["content_goals"]["Row"];

const INITIAL: AcceptReplanState = { error: null, newGoalId: null };

// Form-action wrapper — the banner is a client component using
// useActionState, which expects (prev, formData). Reads proposal_id +
// mode out of the form payload.
export async function acceptReplanProposalAction(
  _prev: AcceptReplanState,
  formData: FormData,
): Promise<AcceptReplanState> {
  const proposalId = formData.get("proposal_id");
  const mode = formData.get("mode");

  if (typeof proposalId !== "string" || !idSchema.safeParse(proposalId).success) {
    return { ...INITIAL, error: "Bad proposal id." };
  }
  const parsedMode = modeSchema.safeParse(mode);
  if (!parsedMode.success) {
    return { ...INITIAL, error: "Bad mode." };
  }

  return acceptReplanProposal(proposalId, parsedMode.data);
}

// Direct invocation path (kept exported for symmetry / future server-side
// callers — e.g. a unit test or an admin tool). The form wrapper above is
// the only V1 caller from UI.
export async function acceptReplanProposal(
  proposalId: string,
  mode: "propose_new" | "dismiss",
): Promise<AcceptReplanState> {
  const ws = await getActiveWorkspaceOrRedirect();
  const user = await getAuthedUserOrRedirect();
  const supabase = await supabaseServer();

  // Resolve the proposal AND its goal in one round-trip. RLS enforces
  // workspace membership via the goal join; if either is missing we
  // bail with a generic message.
  const { data: proposal } = await supabase
    .from("replan_proposals")
    .select("id, goal_id, reason, accepted_at")
    .eq("id", proposalId)
    .maybeSingle();
  if (!proposal) {
    return { ...INITIAL, error: "Proposal not found." };
  }
  if (proposal.accepted_at != null) {
    return { ...INITIAL, error: "Proposal already handled." };
  }

  const { data: goal } = await supabase
    .from("content_goals")
    .select("*")
    .eq("id", proposal.goal_id)
    .eq("workspace_id", ws.id)
    .maybeSingle();
  if (!goal) {
    return { ...INITIAL, error: "Goal not found." };
  }

  if (mode === "dismiss") {
    return dismissProposal(proposalId, user.id, ws.id, goal.id);
  }

  return proposeNewStrategy(
    proposal as { id: string; goal_id: string; reason: string },
    goal as ContentGoalRow,
    user.id,
    ws.id,
  );
}

async function dismissProposal(
  proposalId: string,
  userId: string,
  workspaceId: string,
  goalId: string,
): Promise<AcceptReplanState> {
  const supabase = await supabaseServer();
  // accepted_by tracks the authed user; the dismiss intent rides in the
  // reason tail so we don't need a new column. See file header.
  const { data: existing } = await supabase
    .from("replan_proposals")
    .select("reason")
    .eq("id", proposalId)
    .maybeSingle();
  const newReason = `${existing?.reason ?? "behind"}:dismissed`;

  const { error } = await supabase
    .from("replan_proposals")
    .update({
      accepted_at: new Date().toISOString(),
      accepted_by: userId,
      reason: newReason,
    })
    .eq("id", proposalId);
  if (error) {
    return { ...INITIAL, error: error.message };
  }

  revalidatePath(`/goals/${goalId}`);
  revalidatePath("/goals");
  revalidatePath("/dashboard");
  void workspaceId;
  return { ...INITIAL };
}

async function proposeNewStrategy(
  proposal: { id: string; goal_id: string; reason: string },
  goal: ContentGoalRow,
  userId: string,
  workspaceId: string,
): Promise<AcceptReplanState> {
  const supabase = await supabaseServer();

  // Load brief + connected accounts for proposeStrategy() inputs. Both
  // are required for a meaningful strategy proposal — same gate as
  // /goals/new.
  const [briefRes, accountsRes, progress] = await Promise.all([
    supabase.from("brand_briefs").select("*").eq("workspace_id", workspaceId).maybeSingle(),
    supabase
      .from("social_accounts_safe")
      .select("id, channel, handle")
      .eq("workspace_id", workspaceId)
      .eq("status", "connected"),
    computeGoalProgress(goal.id),
  ]);

  if (!briefRes.data) {
    return { ...INITIAL, error: "Workspace has no brand brief." };
  }
  const connected = (accountsRes.data ?? []).filter((a) =>
    ENABLED_CHANNELS.includes(a.channel as ChannelId),
  );
  if (connected.length === 0) {
    return {
      ...INITIAL,
      error: "Connect at least one channel before replanning.",
    };
  }

  // Build the enriched goal draft. We re-use the original goal_text +
  // metric + target, but APPEND a "## Replan context" block describing
  // what happened so far. The reverse-planner reads goal_text verbatim,
  // so the appendix is the cheapest carrier without changing the
  // proposeStrategy() signature.
  const replanAppendix = buildReplanAppendix(goal, proposal.reason, progress);
  const enrichedDraft: GoalDraft = {
    goal_metric: goal.goal_metric as GoalMetric,
    goal_text: `${goal.goal_text}\n\n${replanAppendix}`,
    target_value: goal.target_value ?? undefined,
    target_date: goal.target_date ?? undefined,
  };

  // proposeStrategy() reads `voiceProfile` + the prose fields off the
  // brand_briefs row; same call shape as /goals/new.
  let strategyResult;
  try {
    const out = await proposeStrategy({
      goal: enrichedDraft,
      channelMix: connected.map((a) => ({
        channel: a.channel as ChannelId,
        handle: a.handle,
      })),
      voiceProfile: briefRes.data.voice_profile,
      productDescription: briefRes.data.product_description,
      targetAudience: briefRes.data.target_audience,
    });
    strategyResult = out.result;
  } catch (err) {
    return {
      ...INITIAL,
      error: err instanceof Error ? err.message : "Replan strategy generation failed.",
    };
  }

  // Validate before persist. The proposeStrategy() helper already
  // re-validates, but we re-narrow here so the JSONB write is type-safe.
  const parsed = proposeStrategyResultSchema.safeParse(strategyResult);
  if (!parsed.success) {
    return { ...INITIAL, error: "Replan strategy validation failed." };
  }

  // Insert the new goal row. Service-role client so the parent_goal_id
  // FK + draft status flip atomically; RLS on the member-write policy
  // would also allow this, but we want service-role for symmetry with
  // generatePostsAction's plan/posts insert pattern.
  const svc = supabaseService();
  const { data: newGoal, error: insertErr } = await svc
    .from("content_goals")
    .insert({
      workspace_id: workspaceId,
      goal_text: goal.goal_text,
      goal_metric: goal.goal_metric as GoalMetric,
      target_value: goal.target_value,
      target_date: goal.target_date,
      status: "draft",
      // Baseline snapshot is the ORIGINAL goal's current actuals — that's
      // the "before" reference for the replanned strategy.
      baseline_snapshot: buildBaselineSnapshot(progress) as Json,
      strategy: parsed.data as unknown as Json,
      parent_goal_id: goal.id,
    })
    .select("id")
    .single();
  if (insertErr || !newGoal) {
    return {
      ...INITIAL,
      error: insertErr?.message ?? "Failed to save replan goal.",
    };
  }

  // Stamp the proposal as accepted. We do this AFTER the goal insert so
  // a failed generation leaves the proposal open for retry. accepted_by
  // is the authed user; the reason tail isn't suffixed (replan is the
  // happy path; dismiss is the labeled path).
  const { error: stampErr } = await supabase
    .from("replan_proposals")
    .update({
      accepted_at: new Date().toISOString(),
      accepted_by: userId,
    })
    .eq("id", proposal.id);
  if (stampErr) {
    console.warn("Failed to stamp replan proposal as accepted:", stampErr);
  }

  revalidatePath(`/goals/${goal.id}`);
  revalidatePath("/goals");
  revalidatePath("/dashboard");

  redirect(`/goals/${newGoal.id}`);
}

// Builds the "## Replan context" block we append to goal_text before
// re-running proposeStrategy(). The reverse-planner reads goal_text
// verbatim, so this appendix is the carrier for the "what happened so
// far" signal without widening the proposeStrategy() signature.
function buildReplanAppendix(
  goal: ContentGoalRow,
  proposalReason: string,
  progress: Awaited<ReturnType<typeof computeGoalProgress>>,
): string {
  const lines: string[] = [];
  lines.push("## Replan context — we are MID-FLIGHT on this goal");
  lines.push(
    "The original strategy ran for some weeks but is now behind pace. Propose a NEW " +
      "strategy that picks up from here. Acknowledge what we tried, double down on what's " +
      "working (themes that shipped), and reroute around what's not (themes that missed).",
  );
  lines.push("");
  lines.push(`Proposal reason: ${proposalReason}`);
  if (!progress) {
    lines.push("(progress snapshot unavailable)");
    return lines.join("\n");
  }
  lines.push(`Pace verdict: ${paceLabel(progress.paceVerdict).toLowerCase()}`);
  if (progress.timeElapsedRatio != null) {
    lines.push(
      `Time elapsed: ${Math.round(progress.timeElapsedRatio * 100)}% of the original window`,
    );
  }
  if (progress.progressRatio != null) {
    lines.push(
      `Progress made: ${Math.round(progress.progressRatio * 100)}% of the target`,
    );
  }
  lines.push(
    `Posts shipped: ${progress.postsShipped}` +
      (progress.postsTarget != null ? ` of ${progress.postsTarget} planned` : ""),
  );
  if (progress.postsScheduled > 0) {
    lines.push(`Posts still queued: ${progress.postsScheduled}`);
  }
  if (progress.actualValue != null && progress.targetValue != null) {
    lines.push(`Metric actual: ${progress.actualValue} / target ${progress.targetValue}`);
  }
  if (progress.baselineValue != null) {
    lines.push(`Metric baseline at goal-start: ${progress.baselineValue}`);
  }
  if (goal.target_date) {
    lines.push(`Original target date: ${goal.target_date}`);
  }
  lines.push("");
  lines.push(
    "The new strategy should respect the same target_value + target_date if possible, " +
      "OR return realistic:false with a closest_achievable plan if the gap-to-target is " +
      "no longer recoverable in the remaining window.",
  );
  return lines.join("\n");
}

// The replanned goal's baseline_snapshot captures the parent's current
// state. The widget's progress computation reads `followers` / `value` /
// `baseline_value` keys; we write all three so any downstream reader
// gets a useful number regardless of which key it looks for.
function buildBaselineSnapshot(
  progress: Awaited<ReturnType<typeof computeGoalProgress>>,
): Record<string, unknown> | null {
  if (!progress) return null;
  const snap: Record<string, unknown> = {
    replanned_from_parent: true,
    posts_shipped_at_replan: progress.postsShipped,
    posts_scheduled_at_replan: progress.postsScheduled,
  };
  if (progress.actualValue != null) {
    snap.value = progress.actualValue;
    snap.baseline_value = progress.actualValue;
  }
  return snap;
}
