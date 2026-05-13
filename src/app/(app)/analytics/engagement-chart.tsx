"use client";

import { useState } from "react";

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
  const [mode, setMode] = useState<Mode>("engagement_rate");

  const values = data.map((d) => d[mode]);
  const max = Math.max(...values, 0);
  const W = 720;
  const H = 200;
  const PAD = 24;
  const innerW = W - PAD * 2;
  const innerH = H - PAD * 2;
  const stepX = data.length > 1 ? innerW / (data.length - 1) : innerW;

  const points = data.map((d, i) => {
    const x = PAD + i * stepX;
    const y = max > 0 ? H - PAD - (d[mode] / max) * innerH : H - PAD;
    return { x, y, d };
  });

  const path = points.length
    ? points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ")
    : "";

  function format(v: number): string {
    if (mode === "engagement_rate") return `${(v * 100).toFixed(2)}%`;
    return v.toLocaleString();
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => setMode(m.id)}
            className={`rounded-md border px-2 py-1 ${
              mode === m.id ? "bg-primary text-primary-foreground" : "hover:bg-muted"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full overflow-visible">
        {/* axis baseline */}
        <line
          x1={PAD}
          y1={H - PAD}
          x2={W - PAD}
          y2={H - PAD}
          stroke="currentColor"
          strokeOpacity={0.2}
        />
        {/* y-axis tick at max */}
        <text x={PAD} y={PAD - 4} fontSize={10} fill="currentColor" opacity={0.6}>
          {format(max)}
        </text>

        {path ? (
          <path d={path} fill="none" stroke="currentColor" strokeWidth={1.5} className="text-primary" />
        ) : null}

        {points.map((p, i) => (
          <g key={i}>
            <circle cx={p.x} cy={p.y} r={3} className="fill-primary" />
            <title>
              {p.d.day} — {format(p.d[mode])} ({p.d.posts} posts)
            </title>
          </g>
        ))}

        {/* x labels — first, middle, last */}
        {[0, Math.floor(points.length / 2), points.length - 1]
          .filter((i) => i >= 0 && i < points.length)
          .map((i) => (
            <text
              key={i}
              x={points[i]!.x}
              y={H - PAD + 14}
              fontSize={10}
              textAnchor="middle"
              fill="currentColor"
              opacity={0.6}
            >
              {points[i]!.d.day.slice(5)}
            </text>
          ))}
      </svg>
    </div>
  );
}
