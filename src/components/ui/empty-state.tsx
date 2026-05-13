import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * EmptyState — drop-in for "no data yet" blocks across the app. Renders a
 * light SVG glyph, a heading, microcopy, and an optional CTA.
 *
 * Pre-baked glyphs (`icon` prop): "inbox", "calendar", "chart", "spark",
 * "plug", "doc". All are zero-dep inline SVGs that adopt currentColor.
 */

type Glyph = "inbox" | "calendar" | "chart" | "spark" | "plug" | "doc";

function EmptyGlyph({ name }: { name: Glyph }) {
  // Soft, geometric, brand-neutral. Stroke + a translucent fill panel so
  // the shape reads at small sizes without dominating the card.
  const common = {
    width: 48,
    height: 48,
    viewBox: "0 0 48 48",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: "text-muted-foreground/70",
  };
  switch (name) {
    case "inbox":
      return (
        <svg {...common}>
          <rect x={8} y={10} width={32} height={28} rx={4} className="fill-muted/40" />
          <path d="M8 28h10l2 4h8l2-4h10" />
          <path d="M16 18h16" opacity={0.5} />
          <path d="M16 22h10" opacity={0.5} />
        </svg>
      );
    case "calendar":
      return (
        <svg {...common}>
          <rect x={8} y={12} width={32} height={26} rx={3} className="fill-muted/40" />
          <path d="M8 20h32" />
          <path d="M16 8v6M32 8v6" />
          <circle cx={18} cy={28} r={1.5} className="fill-current" stroke="none" />
          <circle cx={24} cy={28} r={1.5} className="fill-current" stroke="none" opacity={0.6} />
          <circle cx={30} cy={28} r={1.5} className="fill-current" stroke="none" opacity={0.4} />
        </svg>
      );
    case "chart":
      return (
        <svg {...common}>
          <rect x={8} y={8} width={32} height={32} rx={4} className="fill-muted/40" />
          <path d="M14 30l6-6 5 4 9-10" />
          <circle cx={20} cy={24} r={1.5} className="fill-current" stroke="none" />
          <circle cx={25} cy={28} r={1.5} className="fill-current" stroke="none" />
          <circle cx={34} cy={18} r={1.5} className="fill-current" stroke="none" />
        </svg>
      );
    case "spark":
      return (
        <svg {...common}>
          <path
            d="M24 8l3 8 8 3-8 3-3 8-3-8-8-3 8-3z"
            className="fill-muted/40"
          />
          <path d="M37 30l1.5 3 3 1.5-3 1.5-1.5 3-1.5-3-3-1.5 3-1.5z" opacity={0.6} />
        </svg>
      );
    case "plug":
      return (
        <svg {...common}>
          <rect x={10} y={18} width={22} height={12} rx={3} className="fill-muted/40" />
          <path d="M32 22h6M32 26h6" />
          <path d="M16 12v6M22 12v6" />
        </svg>
      );
    case "doc":
      return (
        <svg {...common}>
          <path d="M14 8h16l8 8v24a2 2 0 0 1-2 2H14a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z" className="fill-muted/40" />
          <path d="M30 8v8h8" />
          <path d="M18 24h14M18 28h14M18 32h10" opacity={0.5} />
        </svg>
      );
  }
}

export function EmptyState({
  icon = "inbox",
  title,
  description,
  action,
  className,
}: {
  icon?: Glyph;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed bg-muted/20 px-6 py-10 text-center",
        className,
      )}
    >
      <EmptyGlyph name={icon} />
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {description ? (
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}
