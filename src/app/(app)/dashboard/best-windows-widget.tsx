import { supabaseService } from "@/lib/supabase/service";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, ChannelBadge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { getOptimalWindows } from "@/lib/timing/analyze";
import type { OptimalWindowsResult, TimeWindow } from "@/lib/timing/schema";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const HOUR_BUCKETS = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22] as const;

// Fetches the channels this workspace has connected. The widget falls back to
// channels with posted_metrics if no social_accounts row exists yet — useful
// for the dogfooding case where someone manually inserted historical data.
async function activeChannels(workspaceId: string): Promise<string[]> {
  const svc = supabaseService();
  const { data } = await svc
    .from("social_accounts")
    .select("channel")
    .eq("workspace_id", workspaceId)
    .neq("status", "revoked");
  const channels = new Set<string>((data ?? []).map((r) => r.channel as string));
  if (channels.size > 0) return Array.from(channels);
  // Fallback: any channel with posted history.
  const { data: postedRows } = await svc
    .from("posts")
    .select("channel")
    .eq("workspace_id", workspaceId)
    .eq("status", "posted")
    .limit(200);
  for (const row of postedRows ?? []) channels.add(row.channel as string);
  return Array.from(channels);
}

export async function BestWindowsWidget({ workspaceId }: { workspaceId: string }) {
  const channels = await activeChannels(workspaceId);
  if (channels.length === 0) {
    return (
      <section className="space-y-3">
        <div>
          <p className="label-eyebrow">Smart timing</p>
          <h2 className="text-base font-medium">Best windows</h2>
        </div>
        <EmptyState
          icon="calendar"
          title="No channels connected yet."
          description="Connect at least one social account and the smart-timing widget will surface your peak posting windows."
        />
      </section>
    );
  }

  const results = await Promise.all(
    channels.map((c) => getOptimalWindows(workspaceId, c, { topN: 5 })),
  );

  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between">
        <div>
          <p className="label-eyebrow">Smart timing</p>
          <h2 className="text-base font-medium">Best windows</h2>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Last 90 days · {results[0]?.timezone ?? "UTC"}
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {results.map((r) => (
          <ChannelHeatmapCard key={r.channel} result={r} />
        ))}
      </div>
    </section>
  );
}

function ChannelHeatmapCard({ result }: { result: OptimalWindowsResult }) {
  const allRates = result.grid.map((g) => g.engagementRate);
  const maxRate = Math.max(...allRates, 0.0001);
  const topKeys = new Set(result.top.slice(0, 5).map((t) => `${t.dayOfWeek}-${t.hourBucket}`));
  const hasObservedData = result.rawSampleCount > 0;

  return (
    <Card className="surface-kpi">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <ChannelBadge channel={result.channel} />
            <span className="text-sm font-medium">Heatmap</span>
          </span>
          {!hasObservedData ? (
            <Badge variant="muted" title="No workspace history yet — showing industry baselines">
              baseline
            </Badge>
          ) : (
            <span className="text-[10px] text-muted-foreground">
              {result.rawSampleCount} post{result.rawSampleCount === 1 ? "" : "s"}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="overflow-x-auto">
          {/* The 2px gap (and the rounded-[2px] cells below) are an intentional
              density outlier off the --radius scale — a heatmap reads as a tight
              tile grid, not as spaced cards. min-w shrinks to 280px so the grid
              fits a 390px viewport, then opens to its natural 420px from sm: up. */}
          <div className="grid min-w-[280px] grid-cols-[24px_repeat(12,minmax(0,1fr))] gap-[2px] text-[9px] tabular-nums sm:min-w-[420px]">
            <div />
            {HOUR_BUCKETS.map((h) => (
              <div
                key={h}
                className="text-center text-[9px] text-muted-foreground"
                title={`${h}:00 – ${h + 2}:00`}
              >
                {h}
              </div>
            ))}
            {DAY_LABELS.map((label, dayIdx) => (
              <DayRow
                key={label}
                label={label}
                dayIdx={dayIdx}
                cells={result.grid.filter((g) => g.dayOfWeek === dayIdx)}
                maxRate={maxRate}
                topKeys={topKeys}
              />
            ))}
          </div>
        </div>
        <TopSlots top={result.top.slice(0, 3)} timezone={result.timezone} />
      </CardContent>
    </Card>
  );
}

function DayRow({
  label,
  dayIdx,
  cells,
  maxRate,
  topKeys,
}: {
  label: string;
  dayIdx: number;
  cells: TimeWindow[];
  maxRate: number;
  topKeys: Set<string>;
}) {
  return (
    <>
      <div className="text-[9px] text-muted-foreground">{label}</div>
      {cells
        .slice()
        .sort((a, b) => a.hourBucket - b.hourBucket)
        .map((cell) => {
          const intensity = Math.max(0.04, cell.engagementRate / maxRate);
          const isTop = topKeys.has(`${dayIdx}-${cell.hourBucket}`);
          // Map intensity to a 0.12–0.90 alpha applied to the --positive token,
          // matching the old #10b981 + hex-alpha ramp without a hardcoded hex.
          const alpha = Math.min(0.9, intensity * 0.78 + 0.12);
          return (
            <div
              key={`${dayIdx}-${cell.hourBucket}`}
              className={
                "h-4 rounded-[2px] transition-colors duration-150 " +
                (cell.isBaseline ? "ring-[0.5px] ring-dashed ring-muted-foreground/30 " : "") +
                (isTop
                  ? "outline outline-1 outline-offset-[1px] outline-[hsl(var(--positive))] "
                  : "")
              }
              style={{ backgroundColor: `hsl(var(--positive) / ${alpha.toFixed(3)})` }}
              title={`${label} ${cell.hourBucket}:00 — ${(cell.engagementRate * 100).toFixed(2)}% engagement${
                cell.isBaseline ? " (baseline)" : ` · ${cell.sampleSize} post${cell.sampleSize === 1 ? "" : "s"}`
              }`}
            />
          );
        })}
    </>
  );
}

function TopSlots({ top, timezone }: { top: TimeWindow[]; timezone: string }) {
  if (top.length === 0) return null;
  return (
    <ul className="space-y-1 text-xs">
      {top.map((slot) => (
        <li
          key={`${slot.dayOfWeek}-${slot.hourBucket}`}
          className="flex items-center justify-between gap-2"
        >
          <span className="tabular-nums">
            {DAY_LABELS[slot.dayOfWeek]} {String(slot.hourBucket).padStart(2, "0")}:00–
            {String((slot.hourBucket + 2) % 24).padStart(2, "0")}:00
          </span>
          <span className="flex items-center gap-2 text-muted-foreground">
            <span className="tabular-nums">{(slot.engagementRate * 100).toFixed(2)}%</span>
            <Badge
              variant={
                slot.confidence === "high"
                  ? "success"
                  : slot.confidence === "medium"
                    ? "info"
                    : "muted"
              }
              title={`${slot.sampleSize} historical post${slot.sampleSize === 1 ? "" : "s"} in this slot${
                slot.isBaseline ? " (baseline only)" : ""
              }`}
            >
              {slot.confidence}
            </Badge>
          </span>
        </li>
      ))}
      <li className="pt-0.5 text-[10px] text-muted-foreground">All times in {timezone}.</li>
    </ul>
  );
}
