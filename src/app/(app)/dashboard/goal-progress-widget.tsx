import Link from "next/link";
import { supabaseService } from "@/lib/supabase/service";
import { Badge } from "@/components/ui/badge";
import { computeGoalProgress, paceLabel, type GoalProgress, type PaceVerdict } from "@/lib/goals/progress";
import type { GoalMetric } from "@/lib/db/types";

// Phase 2.1 follow-up — goal progress dashboard widget.
//
// Server component. Renders one card per active goal, capped at 3
// visible (with "View all" link when there are more). Hides entirely
// when there are no active goals — empty surfaces are worse than no
// surfaces for "feature you haven't started yet" UX.
//
// Each card surfaces:
//   - Pace verdict chip (ahead / on track / behind / tracking)
//   - Strategy summary line (Day X/Y for launch goals, posts shipped/
//     queued for qualitative goals)
//   - Baseline framing when a baseline_snapshot value exists
//   - Replan CTA when there's an unaccepted replan proposal for this
//     goal — routes the user to /goals/[id]?replan=1 (the replan UX
//     itself is a separate slice)
//
// Tone-match: terse, honest, no marketing copy. See best-windows-widget
// and quick-experiments-widget for the reference idiom.

const MAX_VISIBLE = 3;

interface OpenProposal {
  goal_id: string;
  reason: string;
  proposed_at: string;
}

export async function GoalProgressWidget({ workspaceId }: { workspaceId: string }) {
  const svc = supabaseService();

  const { data: activeGoals } = await svc
    .from("content_goals")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("status", "active")
    .order("created_at", { ascending: false });

  if (!activeGoals || activeGoals.length === 0) return null;

  const visibleIds = activeGoals.slice(0, MAX_VISIBLE).map((g) => g.id as string);
  const overflow = Math.max(0, activeGoals.length - MAX_VISIBLE);

  const [progresses, openProposals] = await Promise.all([
    Promise.all(visibleIds.map((id) => computeGoalProgress(id))),
    loadOpenProposals(visibleIds),
  ]);

  const cards = progresses.filter((p): p is GoalProgress => p !== null);
  if (cards.length === 0) return null;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="label-eyebrow">Goals</p>
          <h2 className="text-base font-medium">Progress on what you committed to</h2>
        </div>
        {overflow > 0 ? (
          <Link
            href="/goals"
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            View all ({activeGoals.length}) →
          </Link>
        ) : (
          <Link
            href="/goals"
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Open goals →
          </Link>
        )}
      </div>
      <ul className="divide-y rounded-lg border bg-card">
        {cards.map((p) => (
          <GoalRow
            key={p.goal.id}
            progress={p}
            proposal={openProposals.get(p.goal.id) ?? null}
          />
        ))}
      </ul>
    </section>
  );
}

function GoalRow({
  progress,
  proposal,
}: {
  progress: GoalProgress;
  proposal: OpenProposal | null;
}) {
  const { goal, paceVerdict, summaryLine, baselineValue, targetValue, actualValue } = progress;
  const showVerdict = paceVerdict !== "tracking";
  const hasReplanProposal = proposal !== null;
  return (
    <li className="space-y-1.5 px-4 py-3.5 text-sm transition-colors duration-200 hover:bg-muted/30">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="muted">{metricLabel(goal.goal_metric)}</Badge>
        {showVerdict ? (
          <Badge variant={paceVariant(paceVerdict)}>{paceLabel(paceVerdict)}</Badge>
        ) : (
          <Badge variant="muted">Tracking</Badge>
        )}
        {targetValue != null ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            target {targetValue}
          </span>
        ) : null}
        {goal.target_date ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            by {goal.target_date}
          </span>
        ) : null}
      </div>
      <Link href={`/goals/${goal.id}`} className="block">
        <p className="line-clamp-1 font-medium hover:underline">{goal.goal_text}</p>
      </Link>
      <p className="text-xs text-muted-foreground tabular-nums">
        {summaryLine}
        {baselineValue != null ? (
          <span> · baseline {baselineValue}</span>
        ) : null}
        {actualValue != null && targetValue != null ? (
          <span>
            {" "}· {actualValue}/{targetValue}
          </span>
        ) : null}
      </p>
      {hasReplanProposal ? (
        <p className="pt-1 text-xs">
          <Link
            href={`/goals/${goal.id}?replan=1`}
            className="text-amber-700 underline-offset-4 hover:underline dark:text-amber-400"
          >
            Plan is behind — propose new strategy?
          </Link>
        </p>
      ) : null}
    </li>
  );
}

async function loadOpenProposals(goalIds: string[]): Promise<Map<string, OpenProposal>> {
  if (goalIds.length === 0) return new Map();
  const svc = supabaseService();
  const { data } = await svc
    .from("replan_proposals")
    .select("goal_id, reason, proposed_at")
    .in("goal_id", goalIds)
    .is("accepted_at", null)
    .order("proposed_at", { ascending: false });
  const byGoal = new Map<string, OpenProposal>();
  for (const row of (data ?? []) as OpenProposal[]) {
    if (byGoal.has(row.goal_id)) continue;
    byGoal.set(row.goal_id, row);
  }
  return byGoal;
}

function metricLabel(m: GoalMetric): string {
  switch (m) {
    case "followers":
      return "Followers";
    case "inbound":
      return "Inbound";
    case "launch_date":
      return "Launch";
    case "credibility":
      return "Credibility";
    case "recovery":
      return "Recovery";
    case "custom":
      return "Custom";
  }
}

function paceVariant(v: PaceVerdict): "success" | "warning" | "info" | "muted" {
  switch (v) {
    case "ahead":
      return "success";
    case "on_track":
      return "success";
    case "behind":
      return "warning";
    case "tracking":
      return "muted";
  }
}
