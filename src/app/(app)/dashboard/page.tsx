import Link from "next/link";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { getCalendar, getKpiSummary, getThemeLeaderboard } from "@/lib/dashboard/queries";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, ChannelBadge, statusBadgeLabel, statusBadgeVariant } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { TrustNudge } from "@/components/trust-nudge";
import { isInRecommendedWindow } from "@/lib/channels/best-times";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const ws = await getActiveWorkspaceOrRedirect();
  const [kpis, calendar, themes] = await Promise.all([
    getKpiSummary(ws.id),
    getCalendar(ws.id, 14),
    getThemeLeaderboard(ws.id),
  ]);

  return (
    <div className="space-y-10">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <p className="label-eyebrow">Workspace</p>
          <h1 className="text-3xl font-semibold tracking-tight">{ws.name}</h1>
          <p className="text-sm text-muted-foreground">
            Last 7 days of activity. Metrics refresh hourly — give it a beat after shipping.
          </p>
        </div>
        <Link
          href="/plans/new"
          className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity duration-200 hover:opacity-90"
        >
          Generate plan
        </Link>
      </header>

      <TrustNudge workspaceId={ws.id} />

      <section className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-4">
        <KpiCard label="Posts shipped (7d)" value={kpis.posts_shipped_7d.toString()} />
        <KpiCard
          label="Approval rate"
          value={
            kpis.approval_rate == null
              ? "—"
              : `${Math.round(kpis.approval_rate * 100)}%`
          }
        />
        <KpiCard label="Impressions (7d)" value={kpis.total_impressions_7d.toLocaleString()} />
        <KpiCard
          label="Top theme"
          value={
            kpis.top_theme
              ? `#${kpis.top_theme.theme}`
              : "—"
          }
          sub={
            kpis.top_theme
              ? `${(kpis.top_theme.engagement_rate * 100).toFixed(2)}% engagement`
              : undefined
          }
        />
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="space-y-3 lg:col-span-2">
          <div className="flex items-end justify-between">
            <div>
              <p className="label-eyebrow">Calendar</p>
              <h2 className="text-base font-medium">Next 14 days</h2>
            </div>
            <Link
              href="/queue"
              className="text-xs text-muted-foreground transition-colors duration-200 hover:text-foreground"
            >
              Open queue →
            </Link>
          </div>
          {calendar.length === 0 ? (
            <EmptyState
              icon="calendar"
              title="Calendar's wide open."
              description="Generate a plan and your drafts will land in the queue, then schedule themselves out from here."
              action={
                <Link
                  href="/plans/new"
                  className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity duration-200 hover:opacity-90"
                >
                  Generate plan
                </Link>
              }
            />
          ) : (
            <ul className="divide-y rounded-lg border bg-card">
              {calendar.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between gap-3 px-4 py-3 text-sm transition-colors duration-200 hover:bg-muted/30"
                >
                  <div className="min-w-0 space-y-1">
                    <p className="truncate font-medium">{p.text}</p>
                    <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <ChannelBadge channel={p.channel} />
                      <span className="tabular-nums">
                        {(p.scheduled_at ?? p.posted_at)?.slice(0, 16).replace("T", " ")}
                      </span>
                      {p.theme ? <span>· #{p.theme}</span> : null}
                      {p.scheduled_at && isInRecommendedWindow(p.channel, p.scheduled_at) ? (
                        <Badge
                          variant="success"
                          title={`Within recommended posting window for ${p.channel}`}
                        >
                          best time
                        </Badge>
                      ) : null}
                    </p>
                  </div>
                  <Badge variant={statusBadgeVariant(p.status)} className="shrink-0">
                    {statusBadgeLabel(p.status)}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-3">
          <div className="flex items-end justify-between">
            <div>
              <p className="label-eyebrow">Themes</p>
              <h2 className="text-base font-medium">Leaderboard (30d)</h2>
            </div>
            <Link
              href="/queue"
              className="text-xs text-primary underline-offset-4 transition-colors duration-200 hover:underline"
            >
              {kpis.pending_count} pending →
            </Link>
          </div>
          {themes.length === 0 ? (
            <EmptyState
              icon="spark"
              title="No themes ranked yet."
              description="Ship a handful of posts, wait an hour for metrics to land, and the winners surface here."
            />
          ) : (
            <ul className="divide-y rounded-lg border bg-card">
              {themes.map((t, i) => (
                <li
                  key={t.theme}
                  className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm transition-colors duration-200 hover:bg-muted/30"
                >
                  <span className="flex items-center gap-2.5 min-w-0">
                    <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-muted text-[10px] font-medium tabular-nums text-muted-foreground">
                      {i + 1}
                    </span>
                    <span className="truncate font-medium">#{t.theme}</span>
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {(t.avg_engagement_rate * 100).toFixed(2)}% · {t.posts}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function KpiCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="surface-kpi">
      <CardHeader className="pb-2">
        <CardTitle className="label-eyebrow">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tabular-nums sm:text-3xl">{value}</div>
        {sub ? <p className="mt-1 text-xs text-muted-foreground">{sub}</p> : null}
      </CardContent>
    </Card>
  );
}
