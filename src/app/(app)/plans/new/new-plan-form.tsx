"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ChannelBadge } from "@/components/ui/badge";
import { generatePlanAction, type GeneratePlanState } from "./actions";

interface Account {
  id: string;
  channel: string;
  handle: string;
}

const initial: GeneratePlanState = { error: null, planId: null };

interface RowState {
  include: boolean;
  postsPerWeek: number;
}

// Per-channel sensible default for posts/week. We prefer fewer for
// LinkedIn/Threads (longer copy, lower-cadence platforms) and more for
// X/Bluesky (short-form, higher tolerance for frequency).
const DEFAULTS: Record<string, number> = {
  x: 7,
  bluesky: 7,
  threads: 5,
  linkedin: 3,
  instagram: 3,
};

export function NewPlanForm({ accounts }: { accounts: Account[] }) {
  const [state, formAction, pending] = useActionState(generatePlanAction, initial);
  // Default: include the first account, exclude the rest. Users can flip.
  const [rows, setRows] = useState<Record<string, RowState>>(() => {
    const out: Record<string, RowState> = {};
    accounts.forEach((a, i) => {
      out[a.id] = { include: i === 0, postsPerWeek: DEFAULTS[a.channel] ?? 5 };
    });
    return out;
  });

  const anyIncluded = Object.values(rows).some((r) => r.include);

  return (
    <form action={formAction} className="space-y-8">
      <div className="space-y-3">
        <div className="flex items-end justify-between">
          <div>
            <Label>Channels</Label>
            <p className="text-xs text-muted-foreground">
              Tick the channels to include and pick a per-week cadence for each.
            </p>
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">
            {Object.values(rows).filter((r) => r.include).length}/{accounts.length} on
          </span>
        </div>
        <ul className="divide-y rounded-lg border bg-card">
          {accounts.map((a) => {
            const row = rows[a.id]!;
            return (
              <li
                key={a.id}
                className="flex flex-col gap-3 px-4 py-3 transition-colors duration-200 sm:flex-row sm:items-center sm:gap-3"
              >
                <div className="flex flex-1 items-center gap-3">
                  <input
                    type="checkbox"
                    name={`include_${a.id}`}
                    id={`include_${a.id}`}
                    checked={row.include}
                    onChange={(e) =>
                      setRows((r) => ({ ...r, [a.id]: { ...r[a.id]!, include: e.target.checked } }))
                    }
                    className="h-4 w-4 shrink-0 rounded border-input transition-colors duration-200"
                  />
                  <Label
                    htmlFor={`include_${a.id}`}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5"
                  >
                    <ChannelBadge channel={a.channel} />
                    <span className="truncate text-sm">@{a.handle}</span>
                  </Label>
                </div>
                <div className="flex items-center gap-2 self-end sm:self-auto">
                  <span className="text-xs text-muted-foreground">posts/week</span>
                  <Input
                    type="number"
                    name={`posts_${a.id}`}
                    min={1}
                    max={28}
                    value={row.postsPerWeek}
                    onChange={(e) =>
                      setRows((r) => ({
                        ...r,
                        [a.id]: { ...r[a.id]!, postsPerWeek: Number(e.target.value) || 1 },
                      }))
                    }
                    disabled={!row.include}
                    className="h-9 w-20 text-sm tabular-nums"
                  />
                </div>
              </li>
            );
          })}
        </ul>
        {!anyIncluded ? (
          <p className="text-xs text-destructive">Pick at least one channel to generate a plan.</p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="weeks">Weeks</Label>
        <Input id="weeks" name="weeks" type="number" defaultValue={1} min={1} max={4} required className="w-32" />
        <p className="text-xs text-muted-foreground">
          Claude reads your brief, splits the cadence across channels, and lands every draft in the queue.
        </p>
      </div>

      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          name="compare_competitors"
          id="compare_competitors"
          value="1"
          className="mt-0.5 h-4 w-4 shrink-0 rounded border-input transition-colors duration-200"
        />
        <Label htmlFor="compare_competitors" className="cursor-pointer">
          <span className="block">Compare what competitors are doing</span>
          <span className="block text-xs font-normal text-muted-foreground">
            Analyze top performers on each channel and incorporate what&apos;s working.
          </span>
        </Label>
      </div>

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.planId ? (
        <p className="text-sm text-emerald-600 dark:text-emerald-400">
          Plan generated. Redirecting…
        </p>
      ) : null}

      <Button type="submit" disabled={pending || !anyIncluded} className="w-full">
        {pending ? "Drafting your plan (≈30s)…" : "Generate plan"}
      </Button>
    </form>
  );
}
