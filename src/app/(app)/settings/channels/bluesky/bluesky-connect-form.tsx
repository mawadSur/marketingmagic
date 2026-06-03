"use client";

import { useActionState } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { connectBlueskyAction, type ConnectBlueskyState } from "./actions";

const initial: ConnectBlueskyState = { error: null, success: null };

// The handle validation error from the server action is the only field-specific
// message ("Handle must be a valid domain …"); render it under the handle field.
// Everything else (app-password length, verification, quota, network) is
// non-field and stays at form level.
function isHandleError(error: string | null): boolean {
  return Boolean(error && error.startsWith("Handle "));
}

export function BlueskyConnectForm() {
  const [state, action, pending] = useActionState(connectBlueskyAction, initial);
  const handleError = isHandleError(state.error);
  return (
    <form action={action} className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor="handle">
          Handle <span className="text-destructive">*</span>
        </Label>
        <Input
          id="handle"
          name="handle"
          placeholder="you.bsky.social"
          required
          autoComplete="off"
        />
        {handleError ? <p className="text-xs text-destructive">{state.error}</p> : null}
      </div>
      <div className="space-y-1">
        <Label htmlFor="appPassword">
          App password <span className="text-destructive">*</span>
        </Label>
        <Input
          id="appPassword"
          name="appPassword"
          type="password"
          placeholder="xxxx-xxxx-xxxx-xxxx"
          required
          autoComplete="off"
        />
        <p className="text-xs text-muted-foreground">
          <a
            className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
            href="https://bsky.app/settings/app-passwords"
            target="_blank"
            rel="noreferrer"
          >
            Create an app password
            <ExternalLink className="h-3 w-3" aria-hidden />
          </a>{" "}
          · Don&apos;t use your main login password.
        </p>
      </div>

      {state.error && !handleError ? (
        <p className="text-sm text-destructive">{state.error}</p>
      ) : null}
      {state.success ? (
        <p className="text-sm text-emerald-600 dark:text-emerald-400">{state.success}</p>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Verifying…" : "Connect Bluesky"}
      </Button>
    </form>
  );
}
