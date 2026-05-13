"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

const CHANNEL_LABEL: Record<string, string> = {
  x: "X",
  linkedin: "LinkedIn",
  threads: "Threads",
  instagram: "Instagram",
  bluesky: "Bluesky",
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
    <form action={formAction} className="space-y-6">
      <div className="space-y-3">
        <Label>Channels</Label>
        <ul className="divide-y rounded-lg border">
          {accounts.map((a) => {
            const row = rows[a.id]!;
            return (
              <li key={a.id} className="flex items-center gap-3 px-4 py-3">
                <input
                  type="checkbox"
                  name={`include_${a.id}`}
                  id={`include_${a.id}`}
                  checked={row.include}
                  onChange={(e) =>
                    setRows((r) => ({ ...r, [a.id]: { ...r[a.id]!, include: e.target.checked } }))
                  }
                  className="h-4 w-4 rounded border-input"
                />
                <Label htmlFor={`include_${a.id}`} className="flex flex-1 cursor-pointer items-center gap-3">
                  <span className="rounded-md border px-2 py-0.5 text-xs uppercase tracking-wide">
                    {CHANNEL_LABEL[a.channel] ?? a.channel}
                  </span>
                  <span className="text-sm">@{a.handle}</span>
                </Label>
                <div className="flex items-center gap-2 text-sm">
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
                    className="w-20"
                  />
                </div>
              </li>
            );
          })}
        </ul>
        {!anyIncluded ? (
          <p className="text-xs text-muted-foreground">Pick at least one channel.</p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="weeks">Weeks</Label>
        <Input id="weeks" name="weeks" type="number" defaultValue={1} min={1} max={4} required className="w-32" />
        <p className="text-xs text-muted-foreground">
          Claude reads your brief, splits the cadence across channels, and lands every draft in the queue.
        </p>
      </div>

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.planId ? <p className="text-sm text-emerald-600">Plan generated. Redirecting…</p> : null}

      <Button type="submit" disabled={pending || !anyIncluded} className="w-full">
        {pending ? "Generating (≈30s)…" : "Generate plan"}
      </Button>
    </form>
  );
}
