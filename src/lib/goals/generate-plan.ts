// Goal-anchored plan generation.
//
// Mirrors src/lib/sources/generate-from-source.ts as the architectural twin:
// thin wrapper around generatePlan() that injects a "## Content goal"
// block into the planner's system prompt and reuses everything else
// (theme signals, rejection signals, saved patterns, the multi-variant
// fan-out, voice-score retry loop).
//
// The Phase 2 cross-channel adaptation is preserved exactly — a goal-
// anchored plan still emits `ideas[]` with per-channel variants, still
// respects voice_score/low_confidence, still goes through the same
// skip/idea_id fan-out logic in the persistence layer.
//
// The `goal_id` stamp is applied at the call site (the /goals/[id] server
// action), not here — same separation as source_id.

import type { Database } from "@/lib/db/types";
import { generatePlan, type PlanGenResult } from "@/lib/plan/generate";
import type {
  PlanGenInputs,
  ThemeSignal,
  ThemeWinnerSignal,
  RejectionSignal,
} from "@/lib/plan/prompt";
import type { SavedPattern } from "@/lib/explain/playbook";
import type { ChannelId } from "@/lib/channels/registry";
import type { GoalStrategy } from "@/lib/goals/schema";

type ContentGoalRow = Database["public"]["Tables"]["content_goals"]["Row"];

export interface GeneratePostsFromGoalInputs {
  brief: Database["public"]["Tables"]["brand_briefs"]["Row"];
  goal: ContentGoalRow;
  strategy: GoalStrategy;
  // ChannelMix derived from the strategy's posting_cadence — built by the
  // caller because it needs to resolve handles from social_accounts_safe.
  channelMix: Array<{ channel: ChannelId; handle: string; posts_per_week: number }>;
  // weeks is taken from strategy.weeks, but the caller passes it explicitly
  // so this module doesn't need to know about the strategy parsing layer.
  weeks: number;
  startDate: Date;
  winners?: ThemeSignal[];
  losers?: ThemeSignal[];
  rejections?: RejectionSignal[];
  savedPatterns?: SavedPattern[];
  // Phase 6A — themes whose Bayesian-shrinkage posterior excludes the
  // workspace baseline on the upside. Forwarded straight through to
  // generatePlan(); the goal strategy's theme_weights still take
  // precedence as the planning anchor.
  themeWinners?: ThemeWinnerSignal[];
  retryNote?: string;
}

// Renders a "## Content goal" block injected into the planner prompt.
// Lives here (not in src/lib/plan/prompt.ts) because the planner shouldn't
// know about goal shapes — that's a goals-module concern. We pass the
// already-rendered string through `retryNote` if it weren't already used
// by the voice-retry path; instead we pre-pend it to the user prompt via
// a sidecar field that generatePlan doesn't expose. Workaround: the
// planner currently doesn't accept a free-form "extra context" block, so
// we lean on `retryNote` (which is concatenated to the user prompt and
// is free-form) as the carrier for the goal context. This is a known
// short-term hack — if a third caller needs it we'll add a proper
// extraContext field to PlanGenInputs.
function buildGoalNote(goal: ContentGoalRow, strategy: GoalStrategy): string {
  const lines: string[] = [];
  lines.push("## Content goal (reverse-plan — anchor every idea to this)");
  lines.push(
    "The user committed to a goal and an approved strategy. Every idea in this plan must serve",
    "the milestone arc below. Do not introduce themes outside the strategy's theme_weights.",
  );
  lines.push("");
  lines.push(`### Goal`);
  lines.push(`Metric: ${goal.goal_metric}`);
  if (goal.target_value != null) lines.push(`Target value: ${goal.target_value}`);
  if (goal.target_date) lines.push(`Target date: ${goal.target_date}`);
  lines.push("");
  lines.push("### Goal description");
  lines.push(goal.goal_text);
  lines.push("");
  lines.push("### Strategy summary");
  lines.push(strategy.summary);
  lines.push("");
  lines.push("### Theme weights (bias the mix accordingly)");
  for (const t of strategy.theme_weights) {
    const pct = Math.round(t.weight * 100);
    lines.push(`- ${t.theme} (~${pct}%) — ${t.rationale}`);
  }
  lines.push("");
  lines.push("### Milestone arc (week-by-week — schedule ideas into the matching week)");
  for (const m of strategy.milestones) {
    lines.push(`- Week ${m.week} — ${m.focus}: ${m.description}`);
  }
  lines.push("");
  lines.push("### Success criteria (what 'on track' looks like)");
  for (const s of strategy.success_criteria) {
    lines.push(`- ${s}`);
  }
  if (strategy.risks.length > 0) {
    lines.push("");
    lines.push("### Risks to navigate (don't fall into these failure modes in the copy)");
    for (const r of strategy.risks) {
      lines.push(`- ${r}`);
    }
  }
  return lines.join("\n");
}

export async function generatePostsFromGoal(
  inputs: GeneratePostsFromGoalInputs,
): Promise<PlanGenResult> {
  // Compose the retryNote: when the caller also provided a voice-retry
  // hint, append it after the goal block so both signals reach the model.
  const goalBlock = buildGoalNote(inputs.goal, inputs.strategy);
  const retryNote = inputs.retryNote
    ? `${goalBlock}\n\n${inputs.retryNote}`
    : goalBlock;

  const planInputs: PlanGenInputs = {
    brief: inputs.brief,
    channelMix: inputs.channelMix,
    weeks: inputs.weeks,
    startDate: inputs.startDate,
    winners: inputs.winners,
    losers: inputs.losers,
    rejections: inputs.rejections,
    savedPatterns: inputs.savedPatterns,
    themeWinners: inputs.themeWinners,
    retryNote,
  };
  return generatePlan(planInputs);
}
