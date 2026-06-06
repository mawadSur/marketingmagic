"use client";

// Outcome Loop MVP (Bet 1) — the "Mark outcome" affordance on a ranked post.
//
// Collapsed by default to a small text button so it never crowds the post list.
// Clicking opens an inline panel (mirrors the queue-row reject panel pattern):
// an outcome-type picker, an optional dollar amount, and an optional note.
// Submits to recordOutcomeAction via useActionState; on success it collapses
// and the parent server page re-renders the revenue-ranked themes.
//
// SCOPE: self-report only — this is a human assertion, not platform-confirmed.

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { OUTCOME_TYPES, OUTCOME_TYPE_LABELS } from "@/lib/analytics/outcome-schema";
import { recordOutcomeAction, type RecordOutcomeState } from "./actions";

const initial: RecordOutcomeState = { error: null, success: null };

const SELECT_CLASS =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

export function MarkOutcome({ postId }: { postId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(recordOutcomeAction, initial);
  const wasPending = useRef(false);

  // On a successful submit, collapse the panel and refresh so the new outcome
  // flows into the revenue-ranked themes section. We detect the success edge
  // (pending true → false with no error) rather than firing on every render.
  useEffect(() => {
    if (wasPending.current && !pending && state.success && !state.error) {
      setOpen(false);
      router.refresh();
    }
    wasPending.current = pending;
  }, [pending, state.success, state.error, router]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        title="Did this post drive a lead, sale, signup, or booking? Tag it so themes rank by results."
      >
        Mark outcome
      </button>
    );
  }

  return (
    <form action={action} className="mt-2 space-y-3 rounded-md border bg-muted/30 p-3">
      <input type="hidden" name="post_id" value={postId} />
      <p className="text-xs font-medium">What did this post drive?</p>

      <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
        <label className="space-y-1">
          <span className="label-eyebrow">Outcome</span>
          <select name="outcome_type" defaultValue="lead" className={SELECT_CLASS}>
            {OUTCOME_TYPES.map((t) => (
              <option key={t} value={t}>
                {OUTCOME_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="label-eyebrow">Amount ($, optional)</span>
          <Input
            name="amount_dollars"
            type="number"
            min={0}
            step="0.01"
            placeholder="e.g. 49.99"
            className="h-9 sm:w-36"
          />
        </label>
      </div>

      <label className="block space-y-1">
        <span className="label-eyebrow">Note (optional)</span>
        <Textarea
          name="note"
          rows={2}
          maxLength={280}
          placeholder="e.g. closed via the demo link"
          className="text-xs"
        />
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Save outcome"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
        {state.error ? <span className="text-xs text-destructive">{state.error}</span> : null}
      </div>
    </form>
  );
}
