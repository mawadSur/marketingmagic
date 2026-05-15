import Link from "next/link";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import type { GoalMetric, GoalStatus } from "@/lib/db/types";

export const dynamic = "force-dynamic";

// /goals — list every content_goal the workspace has created. Detail
// (strategy preview + approval) lives at /goals/[id]; the "New goal" CTA
// links to /goals/new. Workspaces with no goals get the cold-start empty
// state. Mirrors /sources page layout.
export default async function GoalsPage() {
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();

  // Aggregate count of posts per goal — same pattern as the sources page.
  // Helps the user spot which goals actually shipped content.
  const [goalsRes, postCountsRes] = await Promise.all([
    supabase
      .from("content_goals")
      .select("id, goal_text, goal_metric, target_value, target_date, status, created_at")
      .eq("workspace_id", ws.id)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("posts")
      .select("goal_id")
      .eq("workspace_id", ws.id)
      .not("goal_id", "is", null),
  ]);

  const goals = goalsRes.data ?? [];
  const postCounts = new Map<string, number>();
  for (const row of postCountsRes.data ?? []) {
    if (row.goal_id) {
      postCounts.set(row.goal_id, (postCounts.get(row.goal_id) ?? 0) + 1);
    }
  }

  return (
    <div className="space-y-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <p className="label-eyebrow">Goals</p>
          <h1 className="text-3xl font-semibold tracking-tight">Content goals</h1>
          <p className="text-sm text-muted-foreground">
            State a goal + timeline. We propose a strategy, then reverse-engineer 4&ndash;12 weeks
            of posts to hit it. Two approval gates so you stay in control.
          </p>
        </div>
        <Link
          href="/goals/new"
          className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity duration-200 hover:opacity-90"
        >
          New goal
        </Link>
      </header>

      {goals.length === 0 ? (
        <EmptyState
          icon="doc"
          title="No goals yet."
          description="A goal is the fastest way to get a coherent month of posts. State what you're trying to hit and we'll build the strategy."
          action={
            <Link
              href="/goals/new"
              className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity duration-200 hover:opacity-90"
            >
              Set your first goal
            </Link>
          }
        />
      ) : (
        <ul className="divide-y rounded-lg border bg-card">
          {goals.map((g) => {
            const postCount = postCounts.get(g.id) ?? 0;
            return (
              <li
                key={g.id}
                className="flex flex-col gap-2 px-4 py-4 transition-colors duration-200 hover:bg-muted/30 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 space-y-1">
                  <Link
                    href={`/goals/${g.id}`}
                    className="block truncate font-medium hover:underline"
                  >
                    {g.goal_text}
                  </Link>
                  <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="muted">{metricLabel(g.goal_metric as GoalMetric)}</Badge>
                    <Badge variant={statusVariant(g.status as GoalStatus)}>
                      {statusLabel(g.status as GoalStatus)}
                    </Badge>
                    {g.target_value != null ? (
                      <span className="tabular-nums">target {g.target_value}</span>
                    ) : null}
                    {g.target_date ? (
                      <span className="tabular-nums">by {g.target_date}</span>
                    ) : null}
                    <span className="tabular-nums">
                      created {new Date(g.created_at).toISOString().slice(0, 10)}
                    </span>
                    <span>· {postCount} post{postCount === 1 ? "" : "s"}</span>
                  </p>
                </div>
                <Link
                  href={`/goals/${g.id}`}
                  className="shrink-0 text-sm text-primary underline-offset-4 transition-colors duration-200 hover:underline"
                >
                  Open →
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
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

function statusLabel(s: GoalStatus): string {
  switch (s) {
    case "draft":
      return "Draft";
    case "active":
      return "Active";
    case "paused":
      return "Paused";
    case "achieved":
      return "Achieved";
    case "abandoned":
      return "Abandoned";
  }
}

function statusVariant(s: GoalStatus): "default" | "muted" | "success" | "warning" | "danger" {
  switch (s) {
    case "active":
      return "success";
    case "achieved":
      return "success";
    case "draft":
      return "muted";
    case "paused":
      return "warning";
    case "abandoned":
      return "danger";
  }
}
