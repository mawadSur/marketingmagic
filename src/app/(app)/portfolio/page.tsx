import { redirect } from "next/navigation";
import { getAuthedUserOrRedirect, listWorkspaces } from "@/lib/workspace";
import { getWorkspaceKpis, type WorkspaceKpis } from "@/lib/portfolio/queries";
import { EmptyState } from "@/components/ui/empty-state";
import { CreateWorkspaceCard, PortfolioCard } from "@/components/portfolio-card";
import { switchAndGoToDashboardAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Phase 4.6 — Multi-Client Dashboard.
 *
 * One page, one trip across every workspace this user belongs to. Cards
 * show top KPIs side-by-side; clicking a card sets the active-workspace
 * cookie and forwards into that workspace's `/dashboard`.
 *
 * If the user only has one workspace, the portfolio view is a no-op —
 * we redirect them straight back to the single-workspace dashboard
 * rather than render a lonely card.
 */
export default async function PortfolioPage() {
  await getAuthedUserOrRedirect();
  const workspaces = await listWorkspaces();
  if (workspaces.length === 0) redirect("/onboarding/workspace");
  if (workspaces.length === 1) redirect("/dashboard");

  const kpis = await Promise.all(workspaces.map((w) => getWorkspaceKpis(w.id)));
  const byId = new Map<string, WorkspaceKpis>(kpis.map((k) => [k.workspace_id, k]));

  const alerts = workspaces
    .map((w) => ({ ws: w, k: byId.get(w.id) }))
    .filter((row) => row.k && row.k.stale_pending_count > 0)
    .sort((a, b) => (b.k!.stale_pending_count - a.k!.stale_pending_count));

  const totalPosts = kpis.reduce((s, k) => s + k.posts_shipped_7d, 0);
  const totalPending = kpis.reduce((s, k) => s + k.pending_count, 0);

  return (
    <div className="space-y-10">
      <header className="space-y-1">
        <p className="label-eyebrow">Portfolio</p>
        <h1 className="text-3xl font-semibold tracking-tight">
          {workspaces.length} workspaces
        </h1>
        <p className="text-sm text-muted-foreground">
          {totalPosts} posts shipped in the last 7 days · {totalPending} pending approval
          {totalPending === 1 ? "" : "s"} across all clients.
          {" "}
          <span className="hidden text-muted-foreground/70 sm:inline">
            Press{" "}
            <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
              ⌘ K
            </kbd>{" "}
            to switch fast.
          </span>
        </p>
      </header>

      {alerts.length > 0 ? (
        <section className="space-y-2">
          <p className="label-eyebrow">Needs attention</p>
          <ul className="space-y-2">
            {alerts.map(({ ws, k }) => (
              <li
                key={ws.id}
                className="flex flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="font-medium text-destructive">
                    {ws.name} — {k!.stale_pending_count} pending approval
                    {k!.stale_pending_count === 1 ? "" : "s"} over 24h
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Older drafts get stale fast. Knock them out or reject so the
                    queue stays clean.
                  </p>
                </div>
                <form action={switchAndGoToDashboardAction} className="shrink-0">
                  <input type="hidden" name="slug" value={ws.slug} />
                  <input type="hidden" name="path" value="/queue" />
                  <button
                    type="submit"
                    className="inline-flex h-8 items-center rounded-md border border-destructive/40 bg-background px-3 text-xs font-medium text-destructive transition-colors duration-200 hover:bg-destructive/10"
                  >
                    Open queue →
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="space-y-3">
        <div className="flex items-end justify-between">
          <div>
            <p className="label-eyebrow">Workspaces</p>
            <h2 className="text-base font-medium">Side-by-side KPIs</h2>
          </div>
        </div>
        {workspaces.length === 0 ? (
          <EmptyState
            icon="inbox"
            title="No workspaces yet."
            description="Create a workspace to start generating plans."
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {workspaces.map((w) => {
              const k = byId.get(w.id);
              if (!k) return null;
              return (
                <PortfolioCard
                  key={w.id}
                  workspace={w}
                  kpis={k}
                  switchAction={switchAndGoToDashboardAction}
                />
              );
            })}
            <CreateWorkspaceCard />
          </div>
        )}
      </section>
    </div>
  );
}
