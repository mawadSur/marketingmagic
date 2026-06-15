// Read-only engagement heatmap for the public best-time-to-post tool.
//
// A standalone (no-auth, no-DB) render of the 7×12 baseline grid. It mirrors the
// visual language of the in-app dashboard "Best windows" widget — the same
// --positive token alpha ramp and tight 2px tile grid — but takes plain
// TimeWindow[] data instead of a workspace-scoped OptimalWindowsResult, so it
// renders fine as a static server component on a public marketing page.

import type { TimeWindow } from "@/lib/timing/schema";
import { DAY_LABELS, HOUR_BUCKETS } from "./platforms";

interface HeatmapProps {
  // The full 84-cell baseline grid (from platformGrid()).
  grid: TimeWindow[];
  // Normaliser for cell intensity (from maxRate()).
  maxRate: number;
  // Keys ("day-hour") of the top windows, drawn with a highlight outline.
  topKeys: Set<string>;
  // Accessible label for the whole grid.
  label: string;
}

export function BestWindowsHeatmap({ grid, maxRate, topKeys, label }: HeatmapProps) {
  return (
    <figure className="space-y-4">
      <div className="overflow-x-auto">
        {/* 2px gap + rounded-[2px] cells: an intentional density outlier off the
            --radius scale so the grid reads as a tight tile field, not cards.
            Matches the dashboard widget. min-w shrinks to 300px for a 390px
            viewport, then opens to its natural width from sm: up. */}
        <div
          role="img"
          aria-label={label}
          className="grid min-w-[300px] grid-cols-[32px_repeat(12,minmax(0,1fr))] gap-[2px] text-[10px] tabular-nums sm:min-w-[460px]"
        >
          <div />
          {HOUR_BUCKETS.map((h) => (
            <div
              key={h}
              className="text-center text-[10px] text-muted-foreground"
              title={`${h}:00 – ${h + 2}:00`}
            >
              {h}
            </div>
          ))}
          {DAY_LABELS.map((dayLabel, dayIdx) => (
            <DayRow
              key={dayLabel}
              dayLabel={dayLabel}
              dayIdx={dayIdx}
              cells={grid.filter((g) => g.dayOfWeek === dayIdx)}
              maxRate={maxRate}
              topKeys={topKeys}
            />
          ))}
        </div>
      </div>
      <figcaption className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-2">
          <span className="text-foreground/70">Less</span>
          <span className="flex items-center gap-[2px]">
            {[0.16, 0.32, 0.5, 0.7, 0.9].map((a) => (
              <span
                key={a}
                className="h-3 w-4 rounded-[2px]"
                style={{ backgroundColor: `hsl(var(--positive) / ${a})` }}
              />
            ))}
          </span>
          <span className="text-foreground/70">More</span>
        </span>
        <span className="flex items-center gap-2">
          <span className="h-3 w-4 rounded-[2px] outline outline-1 outline-offset-[1px] outline-[hsl(var(--positive))]" />
          Peak window
        </span>
        <span>Hours shown in 24h, audience-local time. Each cell is a 2-hour window.</span>
      </figcaption>
    </figure>
  );
}

function DayRow({
  dayLabel,
  dayIdx,
  cells,
  maxRate,
  topKeys,
}: {
  dayLabel: string;
  dayIdx: number;
  cells: TimeWindow[];
  maxRate: number;
  topKeys: Set<string>;
}) {
  return (
    <>
      <div className="flex items-center text-[10px] text-muted-foreground">{dayLabel}</div>
      {cells
        .slice()
        .sort((a, b) => a.hourBucket - b.hourBucket)
        .map((cell) => {
          const intensity = Math.max(0.04, cell.engagementRate / maxRate);
          const isTop = topKeys.has(`${dayIdx}-${cell.hourBucket}`);
          // 0.12–0.90 alpha on the --positive token: same ramp as the dashboard.
          const alpha = Math.min(0.9, intensity * 0.78 + 0.12);
          return (
            <div
              key={`${dayIdx}-${cell.hourBucket}`}
              className={
                "h-5 rounded-[2px] transition-colors duration-150 " +
                (isTop
                  ? "outline outline-1 outline-offset-[1px] outline-[hsl(var(--positive))]"
                  : "")
              }
              style={{ backgroundColor: `hsl(var(--positive) / ${alpha.toFixed(3)})` }}
              title={`${dayLabel} ${cell.hourBucket}:00 — ${(cell.engagementRate * 100).toFixed(
                2,
              )}% relative engagement`}
            />
          );
        })}
    </>
  );
}
