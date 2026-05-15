import Link from "next/link";
import { notFound } from "next/navigation";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { Badge, ChannelBadge, statusBadgeLabel, statusBadgeVariant } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { proposeStrategyResultSchema, type GoalStrategy } from "@/lib/goals/schema";
import type { GoalMetric, GoalStatus } from "@/lib/db/types";
import { GenerateGoalPlanButton } from "./generate-plan-button";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

// /goals/[id] — strategy preview + approval gate.
//
// Reads the draft (or active) goal row, narrows the JSONB `strategy`
// column back into a typed ProposeStrategyResult, and renders:
//   - Realism warning banner when realistic=false
//   - Strategy summary, theme weights, posting cadence, milestone arc,
//     success criteria, risks
//   - "Approve & generate plan" button (server action below) when draft
//   - List of generated posts when active
//
// This page is purely read + approve. Strategy editing is intentionally
// limited to "go back to /goals/new and start over" in V1 — the realism
// gate already pushes a closest_achievable alternative, so the edit
// surface is less load-bearing than it looks. Marked as a follow-up
// in tasks.md.
export default async function GoalDetailPage({ params }: PageProps) {
  const { id } = await params;
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();

  const { data: goal } = await supabase
    .from("content_goals")
    .select("*")
    .eq("id", id)
    .eq("workspace_id", ws.id)
    .maybeSingle();
  if (!goal) notFound();

  // Narrow the JSONB. If parsing fails (manually edited row, future schema
  // drift), render a friendly fallback instead of 500ing. We refuse to
  // approve a goal whose strategy we can't parse.
  const parsedResult = proposeStrategyResultSchema.safeParse(goal.strategy);
  if (!parsedResult.success) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <header className="space-y-1">
          <p className="label-eyebrow">Goal</p>
          <h1 className="text-3xl font-semibold tracking-tight">{goal.goal_text}</h1>
        </header>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Strategy unreadable</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>
              The stored strategy can&apos;t be parsed — it may have been written by an older
              version of the planner. Create a new goal to regenerate it.
            </p>
            <Link href="/goals/new" className="text-primary underline-offset-4 hover:underline">
              New goal →
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }
  const result = parsedResult.data;

  // For the unrealistic branch we surface `closest_achievable` as the
  // "current strategy" — that's what the user can approve. The warning
  // banner stays visible so they know they're committing to the
  // downsized plan, not the original goal.
  const strategy: GoalStrategy = result.realistic ? result.strategy : result.closest_achievable;
  const unrealistic = !result.realistic;
  const unrealisticReason = result.realistic ? null : result.reason;

  // Pull generated posts when the goal is past the draft stage.
  const { data: generatedPosts } = await supabase
    .from("posts")
    .select(
      "id, text, theme, channel, status, scheduled_at, idea_id, voice_score, low_confidence",
    )
    .eq("workspace_id", ws.id)
    .eq("goal_id", id)
    .in("status", ["pending_approval", "scheduled", "posted", "approved"])
    .order("scheduled_at", { ascending: true })
    .limit(100);

  const isDraft = (goal.status as GoalStatus) === "draft";

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <div className="flex items-center gap-2 text-xs">
          <Link
            href="/goals"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            ← All goals
          </Link>
        </div>
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="muted">{metricLabel(goal.goal_metric as GoalMetric)}</Badge>
            <Badge variant={statusVariantFor(goal.status as GoalStatus)}>
              {statusLabel(goal.status as GoalStatus)}
            </Badge>
            {goal.target_value != null ? (
              <span className="text-xs text-muted-foreground tabular-nums">
                target {goal.target_value}
              </span>
            ) : null}
            {goal.target_date ? (
              <span className="text-xs text-muted-foreground tabular-nums">
                by {goal.target_date}
              </span>
            ) : null}
            <span className="text-xs text-muted-foreground tabular-nums">
              created {new Date(goal.created_at).toISOString().slice(0, 10)}
            </span>
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">{goal.goal_text}</h1>
        </div>
      </header>

      {unrealistic ? (
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardHeader>
            <CardTitle className="text-base text-amber-700 dark:text-amber-400">
              Goal-realism check: stretch goal, not silently inflated
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="text-muted-foreground">{unrealisticReason}</p>
            <p className="text-xs text-muted-foreground">
              The strategy below is the closest achievable plan we can defend with weekly content
              alone. Approve it to ship a real cluster — or revise the goal at{" "}
              <Link href="/goals/new" className="underline-offset-4 hover:underline">
                /goals/new
              </Link>
              .
            </p>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Strategy summary</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm leading-relaxed">{strategy.summary}</p>
          <p className="text-xs text-muted-foreground">
            {strategy.weeks} week{strategy.weeks === 1 ? "" : "s"} ·{" "}
            {totalPostsPerWeek(strategy)} posts/week across{" "}
            {strategy.posting_cadence.filter((c) => c.posts_per_week > 0).length} channel(s)
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Theme weights</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3 text-sm">
              {strategy.theme_weights.map((t) => (
                <li key={t.theme} className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">#{t.theme}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {Math.round(t.weight * 100)}%
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">{t.rationale}</p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Posting cadence</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3 text-sm">
              {strategy.posting_cadence.map((c) => (
                <li key={c.channel} className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <ChannelBadge channel={c.channel} />
                    <span className="tabular-nums text-muted-foreground">
                      {c.posts_per_week}/wk
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">{c.rationale}</p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Milestone arc</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="space-y-3 text-sm">
            {strategy.milestones.map((m) => (
              <li key={m.week} className="border-l-2 border-muted pl-3">
                <p className="font-medium">
                  Week {m.week} — {m.focus}
                </p>
                <p className="text-xs text-muted-foreground">{m.description}</p>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Success criteria</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {strategy.success_criteria.map((s, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-muted-foreground">•</span>
                  <span>{s}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        {strategy.risks.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Risks</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2 text-sm">
                {strategy.risks.map((r, i) => (
                  <li key={i} className="flex gap-2 text-muted-foreground">
                    <span>•</span>
                    <span>{r}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ) : null}
      </div>

      {isDraft ? (
        <section className="flex flex-col gap-3 rounded-lg border bg-card p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <p className="label-eyebrow">Approve</p>
            <h2 className="text-base font-medium">
              Generate {strategy.weeks} week{strategy.weeks === 1 ? "" : "s"} of posts from this strategy
            </h2>
            <p className="text-sm text-muted-foreground">
              The planner will produce per-channel variants for every idea and drop drafts in the
              queue. Approval flips this goal to <span className="font-medium">active</span>.
            </p>
          </div>
          <div className="flex gap-2">
            <Link
              href="/goals/new"
              className="inline-flex h-9 items-center rounded-md border border-input bg-background px-3 text-sm font-medium transition-colors hover:bg-muted"
            >
              Edit (start over)
            </Link>
            <GenerateGoalPlanButton goalId={goal.id} />
          </div>
        </section>
      ) : null}

      {generatedPosts && generatedPosts.length > 0 ? (
        <section className="space-y-3">
          <div className="flex items-end justify-between">
            <div>
              <p className="label-eyebrow">Generated</p>
              <h2 className="text-base font-medium">
                {generatedPosts.length} post{generatedPosts.length === 1 ? "" : "s"} from this goal
              </h2>
            </div>
            <Link
              href={`/queue?goal=${goal.id}`}
              className="text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              Open queue →
            </Link>
          </div>
          <ul className="divide-y rounded-lg border bg-card">
            {generatedPosts.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between gap-3 px-4 py-3 text-sm transition-colors hover:bg-muted/30"
              >
                <div className="min-w-0 space-y-1">
                  <p className="line-clamp-2 font-medium">{p.text}</p>
                  <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <ChannelBadge channel={p.channel} />
                    {p.theme ? <span>#{p.theme}</span> : null}
                    {p.scheduled_at ? (
                      <span className="tabular-nums">
                        {p.scheduled_at.slice(0, 16).replace("T", " ")}
                      </span>
                    ) : null}
                  </p>
                </div>
                <Badge variant={statusBadgeVariant(p.status)} className="shrink-0">
                  {statusBadgeLabel(p.status)}
                </Badge>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function totalPostsPerWeek(s: GoalStrategy): number {
  return s.posting_cadence.reduce((sum, c) => sum + c.posts_per_week, 0);
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

function statusVariantFor(s: GoalStatus): "default" | "muted" | "success" | "warning" | "danger" {
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
