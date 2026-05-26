"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { connectXAction, type ConnectXState } from "./actions";

const INITIAL_STATE: ConnectXState = { error: null, success: null };

export function XConnectForm() {
  const [state, action, pending] = useActionState(connectXAction, INITIAL_STATE);
  return (
    <form action={action} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="apiKey">API key</Label>
        <Input id="apiKey" name="apiKey" required autoComplete="off" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="apiSecret">API secret</Label>
        <Input id="apiSecret" name="apiSecret" type="password" required autoComplete="off" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="accessToken">Access token</Label>
        <Input id="accessToken" name="accessToken" required autoComplete="off" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="accessTokenSecret">Access token secret</Label>
        <Input
          id="accessTokenSecret"
          name="accessTokenSecret"
          type="password"
          required
          autoComplete="off"
        />
      </div>
      {state.error ? (
        <p className="text-sm text-destructive">{state.error}</p>
      ) : null}
      {state.success ? (
        <p className="text-sm text-emerald-600 dark:text-emerald-500">{state.success}</p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Verifying…" : "Verify & save"}
      </Button>
    </form>
  );
}
