"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { atomizeSourceAction, type AtomizeState } from "./atomize-actions";

const initial: AtomizeState = { error: null, created: null };

// "Atomize" button — POSTs the source_id to the atomization generator. Unlike
// the cluster button this does NOT redirect: on success it shows how many
// drafts landed and links to the queue, and the source page re-renders its
// "Generated posts" list in place (the action revalidates this path).
export function AtomizeButton({ sourceId }: { sourceId: string }) {
  const [state, formAction, pending] = useActionState(atomizeSourceAction, initial);

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="source_id" value={sourceId} />
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? "Atomizing (≈30s)…" : "Atomize into posts"}
      </Button>
      {state.error ? (
        <p className="max-w-sm text-right text-xs text-destructive">{state.error}</p>
      ) : null}
      {state.created ? (
        <p className="max-w-sm text-right text-xs text-muted-foreground">
          {state.created} draft{state.created === 1 ? "" : "s"} added to your{" "}
          <Link href="/queue" className="underline underline-offset-4 hover:text-foreground">
            queue
          </Link>
          .
        </p>
      ) : null}
    </form>
  );
}
