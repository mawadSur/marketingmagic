"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { generatePostsFromGoal } from "@/lib/goals/generate-plan";
import { proposeStrategyResultSchema, type GoalStrategy } from "@/lib/goals/schema";
import { collectThemeSignals } from "@/lib/plan/signals";
import { collectRejectionSignals } from "@/lib/plan/rejection-signals";
import { loadRecentPatterns } from "@/lib/explain/playbook";
import { loadThemeWinners } from "@/lib/analytics/themes";
import {
  channelSpec,
  ENABLED_CHANNELS,
  type ChannelId,
} from "@/lib/channels/registry";
import { assertWithinPostQuota, QuotaExceededError } from "@/lib/billing/limits";
import { incrementPostsGenerated } from "@/lib/billing/usage";
import type { Json } from "@/lib/db/types";

// /goals/[id] server actions.
//
// Two actions live here, both keyed on goal_id:
//
//   1. generatePostsAction — the "Approve & generate plan" button. Reads
//      the approved strategy out of content_goals.strategy, builds the
//      channelMix from the strategy's posting_cadence + the workspace's
//      connected accounts, calls generatePostsFromGoal(), and persists
//      the same idea→variants fan-out as /plans/new and /sources/[id].
//      Every inserted post row carries `goal_id` so the future progress
//      dashboard can roll engagement up.
//
//   2. approveStrategyAction — exists for symmetry. V1's UX collapses
//      "approve" and "generate posts" into a single click (atomically),
//      but the action is exported separately so a future "approve only,
//      generate later" flow can call it without touching the planner.
//      Idempotent: flips status from draft → active iff it's still draft.
//
// We deliberately do NOT run the best-of-3 voice retry loop here. Goal
// generation is one-shot — the user already approved the strategy, and
// the milestone arc is itself the quality signal. A retry pass would
// burn 3x tokens for ambiguous lift.

const VOICE_SCORE_THRESHOLD = 70;

export type GeneratePostsState = { error: string | null; planId: string | null };
export type ApproveStrategyState = { error: string | null; goalId: string | null };

const idSchema = z.string().uuid();

export async function approveStrategyAction(
  _prev: ApproveStrategyState,
  formData: FormData,
): Promise<ApproveStrategyState> {
  const ws = await getActiveWorkspaceOrRedirect();
  const goalId = formData.get("goal_id");
  if (typeof goalId !== "string" || !idSchema.safeParse(goalId).success) {
    return { error: "Bad goal id.", goalId: null };
  }
  const supabase = await supabaseServer();
  const { error } = await supabase
    .from("content_goals")
    .update({ status: "active" })
    .eq("id", goalId)
    .eq("workspace_id", ws.id)
    .eq("status", "draft");
  if (error) return { error: error.message, goalId: null };
  revalidatePath(`/goals/${goalId}`);
  revalidatePath("/goals");
  return { error: null, goalId };
}

export async function generatePostsAction(
  _prev: GeneratePostsState,
  formData: FormData,
): Promise<GeneratePostsState> {
  const ws = await getActiveWorkspaceOrRedirect();
  const goalId = formData.get("goal_id");
  if (typeof goalId !== "string" || !idSchema.safeParse(goalId).success) {
    return { error: "Bad goal id.", planId: null };
  }

  const supabase = await supabaseServer();

  const [goalRes, briefRes, accountsRes] = await Promise.all([
    supabase
      .from("content_goals")
      .select("*")
      .eq("id", goalId)
      .eq("workspace_id", ws.id)
      .maybeSingle(),
    supabase.from("brand_briefs").select("*").eq("workspace_id", ws.id).maybeSingle(),
    supabase
      .from("social_accounts_safe")
      .select("id, channel, handle, trust_mode")
      .eq("workspace_id", ws.id)
      .eq("status", "connected"),
  ]);

  if (!goalRes.data) return { error: "Goal not found.", planId: null };
  if (!briefRes.data) return { error: "Workspace has no brand brief.", planId: null };

  // Narrow the JSONB strategy back to a typed value. Both branches of
  // the realism gate are acceptable here — the user approved whichever
  // strategy is being displayed, which is closest_achievable for the
  // unrealistic branch.
  const parsedStrategy = proposeStrategyResultSchema.safeParse(goalRes.data.strategy);
  if (!parsedStrategy.success) {
    return {
      error: "Stored strategy can't be parsed. Create a new goal to regenerate it.",
      planId: null,
    };
  }
  const strategy: GoalStrategy = parsedStrategy.data.realistic
    ? parsedStrategy.data.strategy
    : parsedStrategy.data.closest_achievable;

  // Filter to enabled, connected channels. The strategy's posting_cadence
  // may legitimately list a channel that the workspace has disconnected
  // since strategy proposal (rare but possible) — drop those silently
  // rather than fail the whole generation.
  const accounts = (accountsRes.data ?? []).filter((a) =>
    ENABLED_CHANNELS.includes(a.channel as ChannelId),
  );
  if (accounts.length === 0) {
    return {
      error: "Connect at least one channel before generating posts.",
      planId: null,
    };
  }
  const accountByChannel = new Map<string, (typeof accounts)[number]>();
  for (const a of accounts) accountByChannel.set(a.channel, a);

  // Build channelMix from the strategy's posting_cadence ∩ connected
  // accounts. Skip channels with posts_per_week=0 (Claude explicitly
  // dropped them) and channels with no connected account.
  const channelMix: Array<{ channel: ChannelId; handle: string; posts_per_week: number }> = [];
  for (const c of strategy.posting_cadence) {
    if (c.posts_per_week <= 0) continue;
    const acct = accountByChannel.get(c.channel);
    if (!acct) continue;
    channelMix.push({
      channel: c.channel as ChannelId,
      handle: acct.handle,
      posts_per_week: c.posts_per_week,
    });
  }
  if (channelMix.length === 0) {
    return {
      error:
        "Strategy's posting cadence doesn't overlap with any connected channels. Connect a channel or revise the goal.",
      planId: null,
    };
  }

  // Quota check before the LLM call.
  const estimatedPosts = channelMix.reduce(
    (sum, c) => sum + c.posts_per_week * strategy.weeks,
    0,
  );
  try {
    await assertWithinPostQuota(ws.id, estimatedPosts);
  } catch (err) {
    if (err instanceof QuotaExceededError) return { error: err.message, planId: null };
    throw err;
  }

  const [themeSignals, rejections, savedPatterns, themeWinners] = await Promise.all([
    collectThemeSignals(ws.id),
    collectRejectionSignals(ws.id),
    loadRecentPatterns(ws.id),
    loadThemeWinners(ws.id, 5),
  ]);

  // One-shot generation. The strategy itself is the quality contract;
  // re-running 3x for voice drift would burn tokens for marginal lift.
  let result;
  try {
    result = await generatePostsFromGoal({
      brief: briefRes.data,
      goal: goalRes.data,
      strategy,
      channelMix,
      weeks: strategy.weeks,
      startDate: new Date(),
      winners: themeSignals.winners,
      losers: themeSignals.losers,
      rejections,
      savedPatterns,
      themeWinners,
    });
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Generation failed.",
      planId: null,
    };
  }

  // Persist plan + posts. Mirrors the idea→variants fan-out used by
  // /plans/new/actions.ts and /sources/[id]/actions.ts. The one delta is
  // every inserted post carries `goal_id` for goal-attribution rollups.
  const svc = supabaseService();
  const startAt = new Date();
  const endAt = new Date(startAt.getTime() + strategy.weeks * 7 * 24 * 60 * 60 * 1000);

  const { data: planRow, error: planErr } = await svc
    .from("posting_plans")
    .insert({
      workspace_id: ws.id,
      name: result.plan.plan_name,
      start_at: startAt.toISOString(),
      end_at: endAt.toISOString(),
      status: "active",
      parent_plan_id: themeSignals.parent_plan_id,
      generation_prompt: result.plan.overview,
      generation_response: result.plan as unknown as Json,
    })
    .select("id")
    .single();
  if (planErr || !planRow) {
    return { error: planErr?.message ?? "Failed to save plan.", planId: null };
  }

  const hasVoiceProfile = briefRes.data.voice_profile != null;

  type FlatVariant = {
    channel: string;
    text: string;
    theme: string;
    suggested_scheduled_at: string;
    rationale: string;
    image_prompt?: string;
    idea_id: string | null;
    idea_label: string | null;
    voice_score?: number;
  };
  let flatVariants: FlatVariant[];
  if (result.plan.ideas) {
    flatVariants = result.plan.ideas.flatMap((idea) => {
      const ideaId = crypto.randomUUID();
      return idea.variants
        .filter((v) => !v.skip)
        .map((v) => ({
          channel: v.channel,
          text: v.text,
          theme: idea.theme,
          suggested_scheduled_at: idea.suggested_scheduled_at,
          rationale: v.rationale,
          image_prompt: v.image_prompt,
          idea_id: ideaId,
          idea_label: idea.idea_label,
          voice_score: v.voice_score,
        }));
    });
  } else {
    flatVariants = (result.plan.posts ?? []).map((p) => ({
      channel: p.channel,
      text: p.text,
      theme: p.theme,
      suggested_scheduled_at: p.suggested_scheduled_at,
      rationale: p.rationale,
      image_prompt: p.image_prompt,
      idea_id: null,
      idea_label: null,
      voice_score: p.voice_score,
    }));
  }

  const skipped: string[] = [];
  const postsPayload = flatVariants.flatMap((p) => {
    const acct = accountByChannel.get(p.channel);
    if (!acct) {
      skipped.push(p.channel);
      return [];
    }
    const voiceScore = typeof p.voice_score === "number" ? p.voice_score : null;
    const lowConfidence =
      hasVoiceProfile && voiceScore !== null && voiceScore < VOICE_SCORE_THRESHOLD;
    const trusted = acct.trust_mode === true && !lowConfidence;
    const max = channelSpec(acct.channel)?.maxChars ?? 280;
    const text = p.text.length > max ? p.text.slice(0, max - 1) + "…" : p.text;

    return [
      {
        workspace_id: ws.id,
        plan_id: planRow.id,
        social_account_id: acct.id,
        channel: acct.channel,
        text,
        theme: p.theme,
        scheduled_at: p.suggested_scheduled_at,
        status: (trusted ? "scheduled" : "pending_approval") as
          | "scheduled"
          | "pending_approval",
        voice_score: voiceScore,
        low_confidence: lowConfidence,
        idea_id: p.idea_id,
        // Phase 2.1: tag every post with the goal it came from. NULL on
        // any post that wasn't generated through this path — the future
        // progress dashboard treats NULL as "not goal-attributed".
        goal_id: goalId,
        generation_metadata: {
          rationale: p.rationale,
          cache_read_input_tokens: result.usage.cache_read_input_tokens ?? 0,
          auto_scheduled: trusted,
          image_prompt: p.image_prompt ?? null,
          idea_label: p.idea_label,
          goal_id: goalId,
        },
      },
    ];
  });

  if (postsPayload.length === 0) {
    await svc.from("posting_plans").delete().eq("id", planRow.id);
    return {
      error: "Claude generated only posts for channels you haven't connected.",
      planId: null,
    };
  }

  const { error: postsErr } = await svc.from("posts").insert(postsPayload);
  if (postsErr) {
    await svc.from("posting_plans").delete().eq("id", planRow.id);
    return { error: postsErr.message, planId: null };
  }

  // Flip the goal to active. We do this AFTER posts insert so a failed
  // generation leaves the goal in draft for another approval attempt.
  // Service-role bypasses RLS for the atomic plan+posts+goal-status step.
  const { error: statusErr } = await svc
    .from("content_goals")
    .update({ status: "active" })
    .eq("id", goalId);
  if (statusErr) {
    // Posts already landed; surface the warning but don't undo. Status
    // can be flipped manually if this ever fires.
    console.warn("Failed to flip goal status to active:", statusErr);
  }

  try {
    await incrementPostsGenerated(ws.id, postsPayload.length);
  } catch (err) {
    console.warn("Failed to increment posts usage counter:", err);
  }

  revalidatePath("/plans");
  revalidatePath("/queue");
  revalidatePath("/goals");
  revalidatePath(`/goals/${goalId}`);
  if (skipped.length > 0) {
    console.warn("Goal-anchored generator dropped posts for unconnected channels:", skipped);
  }
  redirect(`/queue?goal=${goalId}`);
}
