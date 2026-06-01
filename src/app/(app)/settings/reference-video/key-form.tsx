"use client";

// Reference-image video (bet ④) — BYO fal video key form.
//
// Mirrors the LLM/Pexels key forms in settings/video-keys: a password field with
// show/hide, stored encrypted, never echoed back (Replace or Remove only).

import { useActionState, useState } from "react";
import { Eye, EyeOff, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  saveFalVideoKeyAction,
  removeFalVideoKeyAction,
  type ReferenceVideoState,
} from "./actions";

const initial: ReferenceVideoState = { error: null, success: null };

export function FalVideoKeyStatus({ configured }: { configured: boolean }) {
  return (
    <div className="flex items-center gap-2">
      {configured ? (
        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/5 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
          Configured ✓
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 rounded-full border border-muted-foreground/30 bg-muted/30 px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
          Not configured
        </span>
      )}
      {configured ? (
        <form action={removeFalVideoKeyAction}>
          <Button type="submit" variant="ghost" size="sm" className="text-destructive">
            Remove
          </Button>
        </form>
      ) : null}
    </div>
  );
}

export function FalVideoKeyForm({ configured }: { configured: boolean }) {
  const [state, action, pending] = useActionState(saveFalVideoKeyAction, initial);
  const [showKey, setShowKey] = useState(false);

  return (
    <form action={action} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="api_key">fal API key</Label>
        <div className="relative">
          <Input
            id="api_key"
            name="api_key"
            type={showKey ? "text" : "password"}
            placeholder={configured ? "Enter a new key to replace the stored one" : "fal-key-id:secret"}
            autoComplete="off"
            className="pr-10"
            required
          />
          <button
            type="button"
            onClick={() => setShowKey((s) => !s)}
            className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground hover:text-foreground"
            aria-label={showKey ? "Hide key" : "Show key"}
          >
            {showKey ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          <a
            className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
            href="https://fal.ai/dashboard/keys"
            target="_blank"
            rel="noreferrer"
          >
            Get a fal key
            <ExternalLink className="h-3 w-3" aria-hidden />
          </a>{" "}
          · You pay fal directly. Stored encrypted — never displayed again.
        </p>
      </div>

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.success ? <p className="text-sm text-emerald-600">{state.success}</p> : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : configured ? "Replace fal key" : "Save fal key"}
      </Button>
    </form>
  );
}
