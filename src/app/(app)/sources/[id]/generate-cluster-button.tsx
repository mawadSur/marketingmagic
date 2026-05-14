"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { generateClusterAction, type GenerateClusterState } from "./actions";

const initial: GenerateClusterState = { error: null, planId: null };

// Small form that POSTs the source_id to the cluster generator. We render
// it as a single button + an error line — the action redirects to the
// generated plan on success, so there's no client-side "done" branch.
export function GenerateClusterButton({ sourceId }: { sourceId: string }) {
  const [state, formAction, pending] = useActionState(generateClusterAction, initial);

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="source_id" value={sourceId} />
      <Button type="submit" disabled={pending}>
        {pending ? "Generating (≈30s)…" : "Generate cluster"}
      </Button>
      {state.error ? (
        <p className="max-w-sm text-right text-xs text-destructive">{state.error}</p>
      ) : null}
    </form>
  );
}
