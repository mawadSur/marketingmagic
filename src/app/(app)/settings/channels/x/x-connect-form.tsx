"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { connectXAction, type ConnectXState } from "./actions";

const initial: ConnectXState = { error: null, success: null };

export function XConnectForm() {
  const [state, formAction, pending] = useActionState(connectXAction, initial);

  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="apiKey">API key</Label>
        <Input id="apiKey" name="apiKey" required autoComplete="off" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="apiSecret">API secret</Label>
        <Input id="apiSecret" name="apiSecret" type="password" required autoComplete="off" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="accessToken">Access token</Label>
        <Input id="accessToken" name="accessToken" required autoComplete="off" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="accessTokenSecret">Access token secret</Label>
        <Input
          id="accessTokenSecret"
          name="accessTokenSecret"
          type="password"
          required
          autoComplete="off"
        />
      </div>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.success ? <p className="text-sm text-emerald-600">{state.success}</p> : null}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Verifying…" : "Verify & save"}
      </Button>
    </form>
  );
}
