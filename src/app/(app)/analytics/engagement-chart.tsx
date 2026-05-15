"use client";

import { useEffect, useId, useMemo, useState } from "react";

interface DayBucket {
  day: string;
  posts: number;
  impressions: number;
  engagement: number;
  engagement_rate: number;
}

type Mode = "engagement_rate" | "impressions" | "engagement";

const MODES: Array<{ id: Mode; label: string }> = [
  { id: "engagement_rate", label: "Engagement rate" },
  { id: "impressions", label: "Impressions" },
  { id: "engagement", label: "Engagements" },
];

export function EngagementChart({ data }: { data: DayBucket[] }) {
  // Render-after-mount: the SVG renders SVG <title> hover tooltips whose
  // text varies with the day-bucket data. Server SSR vs client hydration
  // can disagree if a UTC day rolls over between the two, surfacing as a
  // hydration mismatch warning on the analytics page. Skipping SSR here
  // is cheap (the chart isn't SEO-relevant) and stops the warning at the
  // root rather than spot-suppressing each <title> node.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const [mode, setMode] = useState<Mode>("engagement_rate");
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  // Stable per-instance id so multiple charts on a page don't collide
  // on the SVG <defs>/gradient ids.
  const gradId = useId();

  const W = 720;
  const H = 220;
  const PAD_X = 32;
  const PAD_TOP = 16;
  const PAD_BOTTOM = 28;
  const innerW = W - PAD_X * 2;
  const innerH = H - PAD_TOP - PAD_BOTTOM;

  const { points, path, areaPath, max, ticks } = useMemo(() => {
    const values = data.map((d) => d[mode]);
    const rawMax = Math.max(...values, 0);
    // Round up to a "nice" max so y-ticks read cleanly.
    const m = niceCeil(rawMax);
    const stepX = data.length > 1 ? innerW / (data.length - 1) : innerW;
    const pts = data.map((d, i) => {
      const x = PAD_X + i * stepX;
      const y = m > 0 ? H - PAD_BOTTOM - (d[mode] / m) * innerH : H - PAD_BOTTOM;
      return { x, y, d };
    });
    const p = pts.length
      ? pts.map((q, i) => `${i === 0 ? "M" : "L"} ${q.x.toFixed(1)} ${q.y.toFixed(1)}`).join(" ")
      : "";
    const a = pts.length
      ? `${p} L ${pts[pts.length - 1]!.x.toFixed(1)} ${H - PAD_BOTTOM} L ${pts[0]!.x.toFixed(1)} ${H - PAD_BOTTOM} Z`
      : "";
    // Three horizontal gridlines: 0, m/2, m.
    const t = [0, m / 2, m];
    return { points: pts, path: p, areaPath: a, max: m, ticks: t };
  }, [data, mode, innerH, innerW]);

  function format(v: number): string {
    if (mode === "engagement_rate") return `${(v * 100).toFixed(2)}%`;
    return Math.round(v).toLocaleString();
  }

  // For hover detection, find the closest point given a relative x.
  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    if (points.length === 0) return;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = Math.abs(points[i]!.x - px);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    setHoverIdx(best);
  }

  const hover = hoverIdx !== null ? points[hoverIdx] ?? null : null;

  if (!mounted) {
    return (
      <div
        className="h-[260px] w-full animate-pulse rounded-md bg-muted/30"
        aria-label="Loading chart"
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5 text-xs">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => setMode(m.id)}
            className={`rounded-md border px-2.5 py-1 transition-colors duration-200 ${
              mode === m.id
                ? "border-foreground bg-foreground text-background"
                : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full text-primary"
          onMouseMove={onMove}
          onMouseLeave={() => setHoverIdx(null)}
          role="img"
          aria-label={`Daily ${MODES.find((m) => m.id === mode)?.label} for the last ${data.length} days`}
        >
          <defs>
            <linearGradient id={`grad-${gradId}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity={0.18} />
              <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
            </linearGradient>
          </defs>

          {/* gridlines */}
          {ticks.map((t, i) => {
            const y = max > 0 ? H - PAD_BOTTOM - (t / max) * innerH : H - PAD_BOTTOM;
            return (
              <g key={i}>
                <line
                  x1={PAD_X}
                  y1={y}
                  x2={W - PAD_X}
                  y2={y}
                  stroke="currentColor"
                  className="text-muted-foreground"
                  strokeOpacity={0.15}
                  strokeDasharray={i === 0 ? undefined : "3 3"}
                />
                <text
                  x={PAD_X - 6}
                  y={y + 3}
                  fontSize={10}
                  textAnchor="end"
                  className="fill-current text-muted-foreground"
                  opacity={0.7}
                >
                  {format(t)}
                </text>
              </g>
            );
          })}

          {/* area + line */}
          {areaPath ? <path d={areaPath} fill={`url(#grad-${gradId})`} /> : null}
          {path ? (
            <path
              d={path}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.75}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : null}

          {/* x-axis tick labels (start, middle, end) */}
          {[0, Math.floor(points.length / 2), points.length - 1]
            .filter((i) => i >= 0 && i < points.length)
            .map((i) => (
              <text
                key={i}
                x={points[i]!.x}
                y={H - PAD_BOTTOM + 16}
                fontSize={10}
                textAnchor="middle"
                className="fill-current text-muted-foreground"
                opacity={0.7}
              >
                {points[i]!.d.day.slice(5)}
              </text>
            ))}

          {/* hover marker */}
          {hover ? (
            <g>
              <line
                x1={hover.x}
                y1={PAD_TOP}
                x2={hover.x}
                y2={H - PAD_BOTTOM}
                stroke="currentColor"
                strokeOpacity={0.25}
                strokeDasharray="3 3"
              />
              <circle
                cx={hover.x}
                cy={hover.y}
                r={5}
                fill="hsl(var(--background))"
                stroke="currentColor"
                strokeWidth={2}
              />
            </g>
          ) : null}

          {/* invisible larger hit-circles to make hover forgiving */}
          {points.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r={10} fill="transparent">
              <title>
                {p.d.day} — {format(p.d[mode])} ({p.d.posts} posts)
              </title>
            </circle>
          ))}
        </svg>

        {/* hover tooltip — top-left for now (kept simple to avoid measuring) */}
        {hover ? (
          <div className="pointer-events-none absolute right-0 top-0 rounded-md border bg-background/95 px-2.5 py-1.5 text-xs shadow-sm backdrop-blur">
            <div className="font-medium tabular-nums">{format(hover.d[mode])}</div>
            <div className="text-[10px] text-muted-foreground tabular-nums">
              {hover.d.day} · {hover.d.posts} {hover.d.posts === 1 ? "post" : "posts"}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Round up to a visually "nice" max so axis labels read cleanly. e.g.
 * 0.0173 → 0.02, 4321 → 5000, 87 → 100.
 */
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const norm = v / base;
  // Step ladder: 1, 2, 2.5, 5, 10.
  const step =
    norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return step * base;
}
