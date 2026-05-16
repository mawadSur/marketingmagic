// Phase 2.1 follow-up — mid-course replan check.
//
// checkGoalsForReplan(workspaceId) walks every active goal in the
// workspace and returns the goals that:
//
//   1. Have a "behind" pace verdict (time elapsed > progress made),
//   2. Are at least 14 days old (week 2 — earlier than that the noise-
//      to-signal ratio is too low to call anything "behind"),
//   3. Have NOT been replanned in the last 7 days. We track this via
//      `content_goals.last_replan_check_at` (stamped by the cron after
//      each walk) and the most-recent `replan_proposals` row.
//
// The function is read-only. The cron route is the only thing that
// inserts replan_proposals rows or stamps last_replan_check_at. Keeping
// this pure makes it testable + reusable from a future "preview the
// replan proposal" surface.
//
// The replan UX itself is a thin follow-up — the cron + this checker
// land first so the proposal queue starts filling up; the dashboard
// widget surfaces a CTA that just routes to /goals/[id]?replan=1.

import { supabaseService } from "@/lib/supabase/service";
import { computeGoalProgress, type GoalProgress } from "@/lib/goals/progress";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

export interface ReplanCandidate {
  progress: GoalProgress;
  // The "behind_at_week_N" tag the cron writes into replan_proposals.reason.
  // Computed from time-elapsed so the UI can render "your week-3 check
  // flagged this" copy without recomputing.
  reason: string;
}

export async function checkGoalsForReplan(
  workspaceId: string,
): Promise<ReplanCandidate[]> {
  const svc = supabaseService();
  const { data: goals } = await svc
    .from("content_goals")
    .select("id, created_at")
    .eq("workspace_id", workspaceId)
    .eq("status", "active");

  if (!goals || goals.length === 0) return [];

  const now = Date.now();
  const candidates: ReplanCandidate[] = [];

  for (const g of goals) {
    const ageMs = now - new Date(g.created_at).getTime();
    // Week-2 floor. Earlier than this and we'd be raising proposals
    // before the user has had any real chance to execute.
    if (ageMs < TWO_WEEKS_MS) continue;

    // Throttle: did we already propose for this goal in the last 7 days?
    const since = new Date(now - WEEK_MS).toISOString();
    const { data: recent } = await svc
      .from("replan_proposals")
      .select("id")
      .eq("goal_id", g.id)
      .gte("proposed_at", since)
      .limit(1);
    if (recent && recent.length > 0) continue;

    const progress = await computeGoalProgress(g.id);
    if (!progress) continue;
    if (progress.paceVerdict !== "behind") continue;

    candidates.push({
      progress,
      reason: behindReason(ageMs),
    });
  }

  return candidates;
}

function behindReason(ageMs: number): string {
  // Map age in days to a coarse "behind_at_week_N" tag. Caps at week 12
  // because every strategy is at most 12 weeks long.
  const weeks = Math.max(2, Math.min(12, Math.floor(ageMs / (7 * 24 * 60 * 60 * 1000))));
  return `behind_at_week_${weeks}`;
}
