import Link from "next/link";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { Badge, statusBadgeLabel, statusBadgeVariant } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";

export const dynamic = "force-dynamic";

export default async function PlansPage() {
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();
  const { data: plans } = await supabase
    .from("posting_plans")
    .select("id, name, start_at, end_at, status, parent_plan_id, created_at")
    .eq("workspace_id", ws.id)
    .order("created_at", { ascending: false });

  return (
    <div className="space-y-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <p className="label-eyebrow">Posting plans</p>
          <h1 className="text-3xl font-semibold tracking-tight">Plans</h1>
          <p className="text-sm text-muted-foreground">
            Auto-generated posting calendars. Every plan drops fresh drafts into the queue.
          </p>
        </div>
        <Link
          href="/plans/new"
          className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity duration-200 hover:opacity-90"
        >
          New plan
        </Link>
      </header>

      {plans && plans.length > 0 ? (
        <ul className="divide-y rounded-lg border bg-card">
          {plans.map((p) => (
            <li
              key={p.id}
              className="flex items-center justify-between gap-3 px-4 py-3 text-sm transition-colors duration-200 hover:bg-muted/30"
            >
              <div className="min-w-0 space-y-1">
                <Link
                  href={`/plans/${p.id}`}
                  className="block truncate font-medium transition-colors duration-200 hover:underline"
                >
                  {p.name}
                </Link>
                <p className="text-xs tabular-nums text-muted-foreground">
                  {p.start_at.slice(0, 10)} → {p.end_at.slice(0, 10)}
                  {p.parent_plan_id ? " · iteration" : ""}
                </p>
              </div>
              <Badge variant={statusBadgeVariant(p.status)}>{statusBadgeLabel(p.status)}</Badge>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          icon="calendar"
          title="No plans yet."
          description="Generate your first plan and Claude will draft a week (or month) of posts straight into the queue."
          action={
            <Link
              href="/plans/new"
              className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity duration-200 hover:opacity-90"
            >
              Generate plan
            </Link>
          }
        />
      )}
    </div>
  );
}
