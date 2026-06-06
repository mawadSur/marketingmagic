"use client";

import { Badge } from "@/components/ui/badge";
import type { GroupView } from "./groups-manager";

// "Good to post today" — the at-a-glance answer to "where should I post right
// now?" Only groups whose rules ALLOW posting today (ToS-checked) appear here:
//   - open groups
//   - limited groups whose allowed day is today
//   - value_only groups (timing is fine; the card's verdict reminds them to
//     keep it value-first)
// Limited groups on a disallowed day are deliberately excluded — surfacing them
// here would invite a ToS violation.
//
// Each entry shows the recommended time window and the group's content caveat,
// and deep-links (via anchor) to that group's card below where the drafts +
// copy/open actions live.

function caveatFor(g: GroupView): { label: string; variant: "success" | "warning" } {
  if (g.promo_policy === "value_only") {
    return { label: "value-first only", variant: "warning" };
  }
  if (!g.allow_links) {
    return { label: "no links", variant: "warning" };
  }
  return { label: "promo OK", variant: "success" };
}

export function TodayPanel({ groups }: { groups: GroupView[] }) {
  const today = groups.filter((g) => g.allowedToday);

  if (groups.length === 0) return null;

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-base font-medium">Good to post today</h2>
        <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-md border bg-muted/40 px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground">
          {today.length}
        </span>
      </div>

      {today.length === 0 ? (
        <p className="rounded-lg border bg-card px-4 py-3 text-sm text-muted-foreground">
          None of your groups allow promotional posts today. Check the recommended days on each
          group below — posting off-schedule risks removal.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border bg-card">
          {today.map((g) => {
            const caveat = caveatFor(g);
            return (
              <li key={g.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <a
                    href={`#group-${g.id}`}
                    className="font-medium underline-offset-2 hover:underline"
                  >
                    {g.name}
                  </a>
                  <Badge variant={caveat.variant}>{caveat.label}</Badge>
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="tabular-nums">
                    Best time today: <span className="text-foreground">{g.recommendedSlot.timeRange}</span>
                  </span>
                  <a
                    href={`#group-${g.id}`}
                    className="font-medium text-foreground underline-offset-2 hover:underline"
                  >
                    Draft &amp; post →
                  </a>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
