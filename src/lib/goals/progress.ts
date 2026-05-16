// Phase 2.1 follow-up — goal-progress computation.
//
// computeGoalProgress(goalId) reads a content_goal + the posts spawned
// from it, then renders a structured snapshot the dashboard widget (and
// the replan-check cron) can both consume. Latest post_metrics aren't
// part of the pace verdict in V1 — pace is strictly time vs progress.
//
// V1 deliberately keeps the metric-specific logic small:
//
//   - `followers` / `inbound` — workspace-level follower counts and DM
//     tracking aren't wired up in V1. We surface `actualValue=null` so
//     the widget can render a qualitative-progress fallback (post count
//     toward the strategy's posts/week target) instead of pretending we
//     have data we don't.
//
//   - `launch_date` — actual is "days remaining vs total runway." Target
//     is the date itself.
//
//   - `credibility` / `recovery` / `custom` — qualitative. Actual is the
//     count of posts shipped against the strategy's total post target.
//
// Pace verdict compares (time_elapsed / total_time) against (actual /
// target). >5% behind = "behind"; >5% ahead = "ahead"; otherwise "on
// track". When we can't compute a target we return verdict='tracking'
// so the UI never invents a verdict we can't defend.
//
// The widget calls this once per active goal; the cron calls it for
// every active goal in every workspace. Two callers means we keep this
// function pure: read-only DB, no mutations, no side effects.

import { supabaseService } from "@/lib/supabase/service";
import type { Database, Json } from "@/lib/db/types";
import {
  proposeStrategyResultSchema,
  type GoalStrategy,
} from "@/lib/goals/schema";

type ContentGoalRow = Database["public"]["Tables"]["content_goals"]["Row"];

export type PaceVerdict = "ahead" | "on_track" | "behind" | "tracking";

export interface GoalProgress {
  goal: ContentGoalRow;
  strategy: GoalStrategy | null;
  // Latest observed value of the goal metric. `null` when we don't track
  // the metric yet (followers / inbound) or when the goal is qualitative.
  actualValue: number | null;
  // The user-supplied target. Pulled straight from content_goals.target_value.
  targetValue: number | null;
  // The "before" snapshot value if we captured one. Null when baseline
  // wasn't recorded at goal creation (cold-start workspace, missing data).
  baselineValue: number | null;
  // Posts shipped / scheduled toward this goal. Always available.
  postsShipped: number;
  postsScheduled: number;
  // Total posts the strategy plans (sum of milestones × cadence). Null
  // when the strategy is unparseable.
  postsTarget: number | null;
  // 0–1 share of time elapsed between created_at and target_date. Null
  // when there's no target_date.
  timeElapsedRatio: number | null;
  // 0–1 share of progress made against the target. Null when the target
  // is qualitative.
  progressRatio: number | null;
  // The pace label the widget renders. "tracking" when we can't compute
  // a verdict (no target, qualitative metric).
  paceVerdict: PaceVerdict;
  // Free-form one-liner for the UI: "Shipped 4/16 posts" or "Day 9 of 28."
  // Always populated so the widget never renders an empty body.
  summaryLine: string;
}

interface PostRow {
  id: string;
  status: string;
  posted_at: string | null;
  scheduled_at: string | null;
}

export async function computeGoalProgress(
  goalId: string,
): Promise<GoalProgress | null> {
  const svc = supabaseService();

  const { data: goalRow } = await svc
    .from("content_goals")
    .select("*")
    .eq("id", goalId)
    .maybeSingle();
  if (!goalRow) return null;
  const goal = goalRow as ContentGoalRow;

  const strategy = parseStrategy(goal.strategy);

  // Pull posts attached to this goal. We care about both shipped (counts
  // toward "did we follow through?") and still-scheduled (counts toward
  // "will we follow through?"). pending_approval rows count too — they're
  // the user's queue, ready to ship.
  const { data: postRows } = await svc
    .from("posts")
    .select("id, status, posted_at, scheduled_at")
    .eq("goal_id", goalId);

  const posts = (postRows ?? []) as PostRow[];
  const postsShipped = posts.filter((p) => p.status === "posted").length;
  const postsScheduled = posts.filter(
    (p) =>
      p.status === "scheduled" ||
      p.status === "pending_approval" ||
      p.status === "approved",
  ).length;
  const postsTarget = strategy ? computePostsTarget(strategy) : null;

  const timeElapsedRatio = computeTimeElapsedRatio(goal);
  const baselineValue = readBaselineValue(goal);

  // Per-metric branching. Each branch fills actualValue + progressRatio
  // + summaryLine. The pace verdict is computed uniformly below.
  let actualValue: number | null = null;
  let progressRatio: number | null = null;
  let summaryLine = "";

  switch (goal.goal_metric) {
    case "followers":
    case "inbound": {
      // V1 doesn't track followers or inbound DMs at the workspace
      // level. We surface null so the widget can render a qualitative
      // post-count summary instead of inventing a number.
      actualValue = null;
      progressRatio = null;
      summaryLine = renderQualitativeSummary(
        postsShipped,
        postsScheduled,
        postsTarget,
      );
      break;
    }
    case "launch_date": {
      // Actual = days elapsed since goal creation. Target = total days
      // between creation and target_date. Progress ratio is the share
      // of runway consumed — if we're at 50% time and have shipped 80%
      // of the planned posts we'd register as "ahead."
      const totalMs =
        goal.target_date != null
          ? new Date(goal.target_date).getTime() - new Date(goal.created_at).getTime()
          : null;
      const elapsedMs = Date.now() - new Date(goal.created_at).getTime();
      const remainingDays =
        goal.target_date != null
          ? Math.max(
              0,
              Math.ceil(
                (new Date(goal.target_date).getTime() - Date.now()) /
                  (24 * 60 * 60 * 1000),
              ),
            )
          : null;
      actualValue = remainingDays;
      // For launch goals we measure progress by posts-shipped against
      // posts-target, NOT by time. Time elapsed is the denominator the
      // pace verdict already uses.
      if (postsTarget != null && postsTarget > 0) {
        progressRatio = Math.min(1, postsShipped / postsTarget);
      }
      if (remainingDays != null && totalMs != null) {
        const totalDays = Math.max(1, Math.round(totalMs / (24 * 60 * 60 * 1000)));
        const elapsedDays = Math.max(0, Math.round(elapsedMs / (24 * 60 * 60 * 1000)));
        summaryLine = `Day ${elapsedDays}/${totalDays} · ${remainingDays} day${remainingDays === 1 ? "" : "s"} to launch`;
      } else {
        summaryLine = renderQualitativeSummary(postsShipped, postsScheduled, postsTarget);
      }
      break;
    }
    case "credibility":
    case "recovery":
    case "custom": {
      // Qualitative. We use posts-shipped vs strategy's post target as
      // the proxy for "are we following the plan?". No vanity metrics.
      if (postsTarget != null && postsTarget > 0) {
        actualValue = postsShipped;
        progressRatio = Math.min(1, postsShipped / postsTarget);
      }
      summaryLine = renderQualitativeSummary(postsShipped, postsScheduled, postsTarget);
      break;
    }
  }

  const paceVerdict = computePaceVerdict({
    timeElapsedRatio,
    progressRatio,
  });

  return {
    goal,
    strategy,
    actualValue,
    targetValue: goal.target_value,
    baselineValue,
    postsShipped,
    postsScheduled,
    postsTarget,
    timeElapsedRatio,
    progressRatio,
    paceVerdict,
    summaryLine,
  };
}

function parseStrategy(raw: Json | null): GoalStrategy | null {
  if (raw == null) return null;
  const parsed = proposeStrategyResultSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data.realistic ? parsed.data.strategy : parsed.data.closest_achievable;
}

function computePostsTarget(strategy: GoalStrategy): number {
  const perWeek = strategy.posting_cadence.reduce(
    (sum, c) => sum + c.posts_per_week,
    0,
  );
  return perWeek * strategy.weeks;
}

function computeTimeElapsedRatio(goal: ContentGoalRow): number | null {
  if (!goal.target_date) return null;
  const start = new Date(goal.created_at).getTime();
  const end = new Date(goal.target_date).getTime();
  if (end <= start) return null;
  const now = Date.now();
  const ratio = (now - start) / (end - start);
  return Math.max(0, Math.min(1, ratio));
}

function readBaselineValue(goal: ContentGoalRow): number | null {
  // baseline_snapshot is intentionally loose-shaped JSONB. V1 looks for
  // a top-level `followers` or `value` field; downstream the widget just
  // renders "baseline X" when we have a number to anchor against.
  const snap = goal.baseline_snapshot as Record<string, unknown> | null;
  if (!snap) return null;
  const candidates = ["followers", "value", "baseline_value"];
  for (const k of candidates) {
    const v = snap[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

interface PaceInputs {
  timeElapsedRatio: number | null;
  progressRatio: number | null;
}

function computePaceVerdict(inputs: PaceInputs): PaceVerdict {
  const { timeElapsedRatio, progressRatio } = inputs;
  // No time anchor (no target_date) — there's nothing to be ahead or
  // behind of. Render "tracking" so the UI knows to suppress the verdict
  // chip.
  if (timeElapsedRatio == null) return "tracking";
  // No progress anchor (qualitative goal with no posts_target) — same
  // story.
  if (progressRatio == null) return "tracking";
  const delta = progressRatio - timeElapsedRatio;
  if (delta > 0.05) return "ahead";
  if (delta < -0.05) return "behind";
  return "on_track";
}

function renderQualitativeSummary(
  shipped: number,
  scheduled: number,
  target: number | null,
): string {
  if (target != null && target > 0) {
    return `Shipped ${shipped}/${target} · ${scheduled} queued`;
  }
  return `Shipped ${shipped} · ${scheduled} queued`;
}

// Human-readable pace label for the dashboard widget. Kept here (not in
// the widget) so the cron's logging can reuse the same vocabulary.
export function paceLabel(v: PaceVerdict): string {
  switch (v) {
    case "ahead":
      return "Ahead";
    case "on_track":
      return "On track";
    case "behind":
      return "Behind";
    case "tracking":
      return "Tracking";
  }
}
