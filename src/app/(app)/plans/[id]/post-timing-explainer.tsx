import { Badge } from "@/components/ui/badge";
import { explainPostTiming } from "@/lib/timing/analyze";
import type { PostTimingExplain } from "@/lib/timing/schema";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function formatSlot(dayOfWeek: number, hourBucket: number): string {
  const start = String(hourBucket).padStart(2, "0");
  const end = String((hourBucket + 2) % 24).padStart(2, "0");
  return `${DAY_LABELS[dayOfWeek]} ${start}:00–${end}:00`;
}

// Server component — runs the timing analysis for one specific post and
// renders a small explainer row underneath the post text on /plans/[id].
// Renders nothing on failure or for unposted posts (which have no posted_at).
export async function PostTimingExplainer({
  workspaceId,
  channel,
  postedAt,
}: {
  workspaceId: string;
  channel: string;
  postedAt: string | null;
}) {
  if (!postedAt) return null;
  let explain: PostTimingExplain | null;
  try {
    explain = await explainPostTiming(workspaceId, channel, postedAt);
  } catch (err) {
    console.error("[post-timing-explainer] failed", {
      channel,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (!explain) return null;

  return <PostTimingExplainerCard explain={explain} />;
}

// Pure presentational variant — useful for stories / fixtures.
export function PostTimingExplainerCard({ explain }: { explain: PostTimingExplain }) {
  const liftPct = (explain.liftRatio - 1) * 100;
  const isLift = liftPct >= 0;
  const slotLabel = formatSlot(explain.postedDayOfWeek, explain.postedHourBucket);
  const bestLabel = explain.bestSlot
    ? formatSlot(explain.bestSlot.dayOfWeek, explain.bestSlot.hourBucket)
    : null;

  const verdict = (() => {
    if (explain.isBaseline) {
      return {
        tone: "muted" as const,
        line: `Not enough workspace history yet — using industry baseline for ${slotLabel}.`,
      };
    }
    if (Math.abs(liftPct) < 5) {
      return {
        tone: "default" as const,
        line: `${slotLabel} is roughly average for your audience (±${Math.abs(liftPct).toFixed(0)}%).`,
      };
    }
    if (isLift) {
      return {
        tone: "success" as const,
        line: `${slotLabel} — ${liftPct >= 100 ? `${liftPct.toFixed(0)}%` : `+${liftPct.toFixed(0)}%`} above your typical slot.`,
      };
    }
    return {
      tone: "warning" as const,
      line: `${slotLabel} — ${liftPct.toFixed(0)}% below your typical slot.`,
    };
  })();

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      <Badge variant={verdict.tone}>timing</Badge>
      <span className="text-foreground/90">{verdict.line}</span>
      {bestLabel && !explain.isBaseline ? (
        <span className="text-muted-foreground/80">
          Peak: <span className="tabular-nums">{bestLabel}</span>
          {" · "}
          {(explain.bestSlot!.engagementRate * 100).toFixed(2)}%
        </span>
      ) : null}
      <span className="ml-auto text-[10px]">{explain.timezone}</span>
    </div>
  );
}
