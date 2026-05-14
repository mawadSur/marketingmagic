import Link from "next/link";
import { Card } from "@/components/ui/card";
import type { Database } from "@/lib/db/types";
import type { WorkspaceKpis } from "@/lib/portfolio/queries";

type Workspace = Database["public"]["Tables"]["workspaces"]["Row"];

/**
 * Workspace summary card for `/portfolio`. Clicking the card switches the
 * active workspace cookie via a server action (handled in the page) and
 * opens that workspace's `/dashboard`. We keep this presentational — the
 * page wires the switch action onto the wrapping <form>.
 */
export function PortfolioCard({
  workspace,
  kpis,
  switchAction,
}: {
  workspace: Workspace;
  kpis: WorkspaceKpis;
  switchAction: (formData: FormData) => Promise<void>;
}) {
  const trendPct = kpis.engagement_trend_pct;
  const trendLabel =
    trendPct == null
      ? "—"
      : `${trendPct >= 0 ? "+" : ""}${(trendPct * 100).toFixed(1)}%`;
  const trendTone =
    trendPct == null
      ? "text-muted-foreground"
      : trendPct >= 0
        ? "text-emerald-700 dark:text-emerald-400"
        : "text-destructive";

  return (
    <form action={switchAction}>
      <input type="hidden" name="slug" value={workspace.slug} />
      <button
        type="submit"
        className="group block w-full text-left"
        aria-label={`Open ${workspace.name} dashboard`}
      >
        <Card className="h-full p-5 transition-shadow duration-200 group-hover:shadow-md group-focus-visible:ring-2 group-focus-visible:ring-ring">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="label-eyebrow">Workspace</p>
              <h2 className="truncate text-lg font-semibold tracking-tight">
                {workspace.name}
              </h2>
            </div>
            <span
              className="shrink-0 text-xs text-muted-foreground transition-colors duration-200 group-hover:text-foreground"
              aria-hidden
            >
              Open →
            </span>
          </div>

          <dl className="mt-4 grid grid-cols-2 gap-3">
            <Metric label="Posts (7d)" value={kpis.posts_shipped_7d.toString()} />
            <Metric
              label="Approval rate"
              value={
                kpis.approval_rate == null
                  ? "—"
                  : `${Math.round(kpis.approval_rate * 100)}%`
              }
            />
            <Metric
              label="Top theme"
              value={kpis.top_theme ? `#${kpis.top_theme.theme}` : "—"}
              sub={
                kpis.top_theme
                  ? `${(kpis.top_theme.engagement_rate * 100).toFixed(2)}%`
                  : undefined
              }
            />
            <Metric
              label="Engagement Δ"
              value={trendLabel}
              valueClassName={trendTone}
              sub={
                kpis.engagement_rate_7d != null
                  ? `${(kpis.engagement_rate_7d * 100).toFixed(2)}% now`
                  : undefined
              }
            />
          </dl>

          {kpis.pending_count > 0 ? (
            <p className="mt-4 text-xs text-muted-foreground">
              {kpis.pending_count} pending approval{kpis.pending_count === 1 ? "" : "s"}
            </p>
          ) : null}
        </Card>
      </button>
    </form>
  );
}

function Metric({
  label,
  value,
  sub,
  valueClassName,
}: {
  label: string;
  value: string;
  sub?: string;
  valueClassName?: string;
}) {
  return (
    <div>
      <dt className="label-eyebrow text-[10px]">{label}</dt>
      <dd className={`text-base font-semibold tabular-nums sm:text-lg ${valueClassName ?? ""}`}>
        {value}
      </dd>
      {sub ? <p className="text-[11px] text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

/**
 * Compact "manage your portfolio" entry on `/portfolio`. Renders a Link
 * for the create-workspace flow inline with the card grid.
 */
export function CreateWorkspaceCard() {
  return (
    <Link
      href="/workspaces/new"
      className="group flex h-full min-h-[180px] items-center justify-center rounded-lg border border-dashed bg-muted/20 px-6 text-center text-sm text-muted-foreground transition-colors duration-200 hover:border-foreground/30 hover:bg-muted/40 hover:text-foreground"
    >
      <span>
        + New workspace
        <span className="block text-[11px] text-muted-foreground/70 group-hover:text-muted-foreground">
          Add another client or project
        </span>
      </span>
    </Link>
  );
}
