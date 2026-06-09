"use client";

import { useActionState, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  generatePlanAction,
  type GeneratePlanState,
} from "@/app/(app)/plans/new/actions";
import { displayHandle } from "@/lib/channels/registry";

interface Account {
  id: string;
  channel: string;
  handle: string;
}

const CHANNEL_LABEL: Record<string, string> = {
  x: "X",
  linkedin: "LinkedIn",
  threads: "Threads",
  instagram: "Instagram",
  bluesky: "Bluesky",
};

const initial: GeneratePlanState = { error: null, planId: null };

interface Step3PlanProps {
  accounts: Account[];
}

/**
 * Step 3: a compact build of /plans/new — pick which connected accounts
 * to include, defaults to 1 week and 5 posts/week per account. Submits
 * through the existing `generatePlanAction`, which redirects to
 * /plans/[id] on success (Claude takes ~30s to draft).
 */
export function Step3Plan({ accounts }: Step3PlanProps) {
  const [state, formAction, pending] = useActionState(generatePlanAction, initial);
  // Default: include every connected account at 5 posts/week.
  const [included, setIncluded] = useState<Record<string, boolean>>(() => {
    const out: Record<string, boolean> = {};
    accounts.forEach((a) => (out[a.id] = true));
    return out;
  });

  const anyIncluded = Object.values(included).some(Boolean);

  return (
    <form action={formAction} className="space-y-6">
      <Card>
        <CardContent className="space-y-4 p-6">
          <div className="space-y-1">
            <Label className="text-sm font-medium">Where should we post?</Label>
            <p className="text-xs text-muted-foreground">
              We&apos;ll draft 5 posts per channel for the first week. Every draft lands in your queue
              for approval before going live.
            </p>
          </div>
          <ul className="divide-y rounded-md border">
            {accounts.map((a) => {
              const checked = included[a.id] ?? false;
              return (
                <li key={a.id} className="flex items-center gap-3 px-4 py-3">
                  <input
                    type="checkbox"
                    name={`include_${a.id}`}
                    id={`include_${a.id}`}
                    checked={checked}
                    onChange={(e) =>
                      setIncluded((prev) => ({ ...prev, [a.id]: e.target.checked }))
                    }
                    className="h-4 w-4 rounded border-input"
                  />
                  <Label
                    htmlFor={`include_${a.id}`}
                    className="flex flex-1 cursor-pointer items-center gap-3"
                  >
                    <span className="rounded-md border px-2 py-0.5 text-xs uppercase tracking-wide">
                      {CHANNEL_LABEL[a.channel] ?? a.channel}
                    </span>
                    <span className="text-sm">{displayHandle(a.handle)}</span>
                  </Label>
                  {/* Hard-coded 5 posts/week to match the brief's "default to
                      1 week + 5 posts/week" spec. Field has to exist for the
                      generate action to pick it up. */}
                  <input type="hidden" name={`posts_${a.id}`} value="5" />
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      <input type="hidden" name="weeks" value="1" />

      {state.error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {state.error}
        </div>
      ) : null}

      <Button type="submit" size="lg" className="w-full" disabled={pending || !anyIncluded}>
        {pending ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
            Drafting (this takes about 30 seconds)…
          </>
        ) : (
          <>
            <Sparkles className="mr-2 h-4 w-4" aria-hidden />
            Generate my first week
          </>
        )}
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        Nothing publishes automatically. You approve every post.
      </p>
    </form>
  );
}
