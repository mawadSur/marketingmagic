import type { PortalReport as PortalReportData } from "@/lib/portal/data";

// Read-only performance report rendered inside the portal page. The PDF route
// renders the same data with a print-oriented layout.
export function PortalReport({
  report,
  accent,
}: {
  report: PortalReportData;
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
    <div className="space-y-4">
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
