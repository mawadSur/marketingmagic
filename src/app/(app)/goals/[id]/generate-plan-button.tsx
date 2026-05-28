"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { generatePostsAction, type GeneratePostsState } from "./actions";

const initial: GeneratePostsState = { error: null, planId: null };

// Small form that POSTs the goal_id to the goal-anchored plan generator.
// Mirrors GenerateClusterButton in /sources/[id] — single button + an
// error line, redirect on success.
export function GenerateGoalPlanButton({ goalId }: { goalId: string }) {
  const [state, formAction, pending] = useActionState(generatePostsAction, initial);

  return (
    <form action={formAction} className="flex flex-col items-end gap-2">
      <input type="hidden" name="goal_id" value={goalId} />
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          name="compare_competitors"
          id="compare_competitors"
          value="1"
          className="mt-0.5 h-4 w-4 shrink-0 rounded border-input transition-colors duration-200"
        />
        <Label htmlFor="compare_competitors" className="cursor-pointer text-right">
          <span className="block">Compare what competitors are doing</span>
          <span className="block text-xs font-normal text-muted-foreground">
            Analyze top performers on each channel and incorporate what&apos;s working.
          </span>
        </Label>
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Generating (≈45s)…" : "Approve & generate plan"}
      </Button>
      {state.error ? (
        <p className="max-w-sm text-right text-xs text-destructive">{state.error}</p>
      ) : null}
    </form>
  );
}
