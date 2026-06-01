import type { PortalReport as PortalReportData, PortalInsights } from "@/lib/portal/data";

// Read-only performance report rendered inside the portal page. The PDF route
// renders the same data with a print-oriented layout.
export function PortalReport({
  report,
  insights,
  accent,
}: {
  report: PortalReportData;
  insights: PortalInsights | null;
  accent: string;
}) {
  if (report.rows.length === 0) {
    return (
      <p className="rounded-lg border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
        No scheduled or published posts yet. Numbers will appear here as content goes live.
      </p>
    );
  }

  const { totals } = report;
  return (
    <div className="space-y-6">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Posts" value={totals.posts.toLocaleString()} accent={accent} />
        <Stat label="Impressions" value={totals.impressions.toLocaleString()} accent={accent} />
        <Stat label="Engagements" value={totals.engagements.toLocaleString()} accent={accent} />
        <Stat
          label="Avg. eng. rate"
          value={
            totals.avgEngagementRate === null
              ? "—"
              : `${(totals.avgEngagementRate * 100).toFixed(1)}%`
          }
          accent={accent}
        />
      </dl>

      {insights && insights.winningThemes.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">What&apos;s working — winning themes</h3>
          <ul className="flex flex-wrap gap-2">
            {insights.winningThemes.map((t) => (
              <li
                key={t.tag}
                className="rounded-full border px-3 py-1 text-xs"
                style={{ borderColor: accent }}
              >
                <span className="font-medium text-foreground">{t.tag}</span>{" "}
                <span className="tabular-nums" style={{ color: accent }}>
                  {t.lift.toFixed(1)}× baseline
                </span>{" "}
                <span className="text-muted-foreground">· {t.posts} posts</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {insights && insights.channels.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">By channel (30 days)</h3>
          <div className="overflow-hidden rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Channel</th>
                  <th className="px-3 py-2 text-right font-medium">Posts</th>
                  <th className="px-3 py-2 text-right font-medium">Impr.</th>
                  <th className="px-3 py-2 text-right font-medium">Eng. rate</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {insights.channels.map((c) => (
                  <tr key={c.channel}>
                    <td className="px-3 py-2 uppercase text-muted-foreground">{c.channel}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {c.posts.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {c.impressions.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {(c.engagement_rate * 100).toFixed(1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <div className="overflow-hidden rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Post</th>
              <th className="px-3 py-2 text-left font-medium">Channel</th>
              <th className="px-3 py-2 text-right font-medium">Impr.</th>
              <th className="px-3 py-2 text-right font-medium">Eng.</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {report.rows.map((r) => {
              const eng = (r.likes ?? 0) + (r.reposts ?? 0) + (r.replies ?? 0) + (r.clicks ?? 0);
              return (
                <tr key={r.id}>
                  <td className="max-w-[18rem] px-3 py-2">
                    <span className="line-clamp-2 text-foreground">{r.text}</span>
                  </td>
                  <td className="px-3 py-2 uppercase text-muted-foreground">{r.channel}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.impressions?.toLocaleString() ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{eng.toLocaleString()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums" style={{ color: accent }}>
        {value}
      </dd>
    </div>
  );
}
