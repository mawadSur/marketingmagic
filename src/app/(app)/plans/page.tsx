import Link from "next/link";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";

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
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Plans</h1>
          <p className="text-sm text-muted-foreground">
            Auto-generated posting calendars. Each plan creates drafts in the queue for approval.
          </p>
        </div>
        <Link
          href="/plans/new"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          New plan
        </Link>
      </header>

      {plans && plans.length > 0 ? (
        <ul className="divide-y rounded-lg border">
          {plans.map((p) => (
            <li key={p.id} className="flex items-center justify-between px-4 py-3 text-sm">
              <div>
                <Link href={`/plans/${p.id}`} className="font-medium hover:underline">
                  {p.name}
                </Link>
                <p className="text-xs text-muted-foreground">
                  {p.start_at.slice(0, 10)} → {p.end_at.slice(0, 10)}
                  {p.parent_plan_id ? " · iteration" : ""}
                </p>
              </div>
              <span className="rounded-md border px-2 py-0.5 text-xs uppercase tracking-wide">
                {p.status}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-lg border p-6 text-sm text-muted-foreground">
          No plans yet.{" "}
          <Link href="/plans/new" className="text-primary underline-offset-4 hover:underline">
            Generate one.
          </Link>
        </p>
      )}
    </div>
  );
}
