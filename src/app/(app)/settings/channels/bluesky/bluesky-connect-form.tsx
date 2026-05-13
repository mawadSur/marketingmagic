"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { connectBlueskyAction, type ConnectBlueskyState } from "./actions";

const initial: ConnectBlueskyState = { error: null, success: null };

export function BlueskyConnectForm() {
  const [state, action, pending] = useActionState(connectBlueskyAction, initial);
  return (
    <form action={action} className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor="handle">Handle</Label>
        <Input
          id="handle"
          name="handle"
          placeholder="you.bsky.social"
          required
          autoComplete="off"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="appPassword">App password</Label>
        <Input
          id="appPassword"
          name="appPassword"
          type="password"
          placeholder="xxxx-xxxx-xxxx-xxxx"
          required
          autoComplete="off"
        />
        <p className="text-xs text-muted-foreground">
          Create at bsky.app/settings/app-passwords. Don&apos;t use your main login password.
        </p>
      </div>

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.success ? <p className="text-sm text-emerald-600">{state.success}</p> : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Verifying…" : "Connect Bluesky"}
      </Button>
    </form>
  );
}
