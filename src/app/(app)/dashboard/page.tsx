import Link from "next/link";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { getCalendar, getKpiSummary, getThemeLeaderboard } from "@/lib/dashboard/queries";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
    <div className="space-y-8">
      <header className="flex items-end justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{ws.name}</h1>
          <p className="text-sm text-muted-foreground">
            Last 7 days of activity. Cron pulls metrics hourly.
          </p>
        </div>
        <Link
          href="/plans/new"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Generate plan
        </Link>
      </header>

      <TrustNudge workspaceId={ws.id} />

      <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
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
          <h2 className="text-sm font-medium">Next 14 days</h2>
          {calendar.length === 0 ? (
            <p className="rounded-lg border p-4 text-sm text-muted-foreground">
              Nothing scheduled. Approve drafts in the queue or generate a new plan.
            </p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {calendar.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between gap-4 px-4 py-3 text-sm"
                >
                  <div className="min-w-0 space-y-1">
                    <p className="truncate font-medium">{p.text}</p>
                    <p className="text-xs text-muted-foreground">
                      {(p.scheduled_at ?? p.posted_at)?.slice(0, 16).replace("T", " ")}
                      {p.theme ? ` · #${p.theme}` : ""}
                      {p.scheduled_at && isInRecommendedWindow(p.channel, p.scheduled_at) ? (
                        <span
                          className="ml-2 rounded-sm bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400"
                          title={`Within recommended posting window for ${p.channel}`}
                        >
                          best time
                        </span>
                      ) : null}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-md border px-2 py-0.5 text-[10px] uppercase">
                    {p.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">Theme leaderboard (30d)</h2>
            <Link
              href="/queue"
              className="text-xs text-primary underline-offset-4 hover:underline"
            >
              {kpis.pending_count} pending →
            </Link>
          </div>
          {themes.length === 0 ? (
            <p className="rounded-lg border p-4 text-sm text-muted-foreground">
              No metrics yet. Shipping a few posts then waiting an hour seeds this view.
            </p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {themes.map((t) => (
                <li key={t.theme} className="flex items-center justify-between px-4 py-2 text-sm">
                  <span>#{t.theme}</span>
                  <span className="text-xs tabular-nums text-muted-foreground">
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
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold">{value}</div>
        {sub ? <p className="mt-1 text-xs text-muted-foreground">{sub}</p> : null}
      </CardContent>
    </Card>
  );
}
