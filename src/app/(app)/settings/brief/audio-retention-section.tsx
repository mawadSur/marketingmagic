"use client";

import { useActionState, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  updateAudioRetentionAction,
  type AudioRetentionState,
} from "./audio-retention-actions";

// Phase 2.6 — voice-memo audio retention toggle.
//
// A single opt-in checkbox: OFF (default) deletes the raw recording right
// after transcription; ON keeps it in the private founder-audio vault for
// 30 days. Backs brand_briefs.audio_retention_opt_in (migration 050) via
// updateAudioRetentionAction. Only rendered when a brief row exists (the
// action requires one), so `initialOptIn` is always a real stored value.

const initialState: AudioRetentionState = { error: null, message: null };

export function AudioRetentionSection({ initialOptIn }: { initialOptIn: boolean }) {
  const [state, formAction, pending] = useActionState(
    updateAudioRetentionAction,
    initialState,
  );

  // Track the checkbox locally so the Save button can disable when the
  // value matches what's saved. We re-sync to the stored value after a
  // successful save (no error + a confirmation message came back).
  const [checked, setChecked] = useState(initialOptIn);
  const [saved, setSaved] = useState(initialOptIn);
  useEffect(() => {
    if (!state.error && state.message) setSaved(checked);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <section className="space-y-3 rounded-lg border bg-muted/20 p-4">
      <div className="space-y-1">
        <Label htmlFor="audio_retention_opt_in" className="text-sm">
          Voice-memo audio retention
        </Label>
        <p className="text-xs text-muted-foreground">
          By default we delete the raw recording the moment it&apos;s
          transcribed — only the transcript is kept. Turn this on to keep the
          audio in your private vault for 30 days (useful for voice-cloning
          later).
        </p>
      </div>

      <form action={formAction} className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            id="audio_retention_opt_in"
            type="checkbox"
            name="opt_in"
            value="on"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            className="h-4 w-4 rounded border-input"
          />
          Keep my voice-memo audio for 30 days
        </label>

        <Button type="submit" disabled={pending || checked === saved} className="sm:ml-auto sm:shrink-0">
          {pending ? "Saving…" : "Save"}
        </Button>
      </form>

      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
      {state.message && !state.error ? (
        <p className="text-xs text-emerald-600 dark:text-emerald-400">{state.message}</p>
      ) : null}
    </section>
  );
}
