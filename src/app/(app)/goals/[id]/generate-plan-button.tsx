"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { generatePostsAction, type GeneratePostsState } from "./actions";

const initial: GeneratePostsState = { error: null, planId: null };

// Small form that POSTs the goal_id to the goal-anchored plan generator.
// Mirrors GenerateClusterButton in /sources/[id] — single button + an
// error line, redirect on success.
export function GenerateGoalPlanButton({ goalId }: { goalId: string }) {
  const [state, formAction, pending] = useActionState(generatePostsAction, initial);

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="goal_id" value={goalId} />
      <Button type="submit" disabled={pending}>
        {pending ? "Generating (≈45s)…" : "Approve & generate plan"}
      </Button>
      {state.error ? (
        <p className="max-w-sm text-right text-xs text-destructive">{state.error}</p>
      ) : null}
    </form>
  );
}
