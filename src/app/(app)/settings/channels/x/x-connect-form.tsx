"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { connectXAction, type ConnectXState } from "./actions";

const INITIAL_STATE: ConnectXState = { error: null, success: null };

// The four credential fields all share a single "All four fields are required."
// validation error from the server action; surface that under each empty-prone
// field group as a form-level notice. Any other error (verification, quota,
// network) is non-field and stays at form level.
const REQUIRED_FIELDS_ERROR = "All four fields are required.";

export function XConnectForm() {
  const [state, action, pending] = useActionState(connectXAction, INITIAL_STATE);
  const isRequiredError = state.error === REQUIRED_FIELDS_ERROR;
  return (
    <form action={action} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="apiKey">
          API key <span className="text-destructive">*</span>
        </Label>
        <Input id="apiKey" name="apiKey" required autoComplete="off" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="apiSecret">
          API secret <span className="text-destructive">*</span>
        </Label>
        <Input id="apiSecret" name="apiSecret" type="password" required autoComplete="off" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="accessToken">
          Access token <span className="text-destructive">*</span>
        </Label>
        <Input id="accessToken" name="accessToken" required autoComplete="off" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="accessTokenSecret">
          Access token secret <span className="text-destructive">*</span>
        </Label>
        <Input
          id="accessTokenSecret"
          name="accessTokenSecret"
          type="password"
          required
          autoComplete="off"
        />
        {isRequiredError ? (
          <p className="text-xs text-destructive">{state.error}</p>
        ) : null}
      </div>
      {state.error && !isRequiredError ? (
        <p className="text-sm text-destructive">{state.error}</p>
      ) : null}
      {state.success ? (
        <p className="text-sm text-emerald-600 dark:text-emerald-400">{state.success}</p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Verifying…" : "Verify & save"}
      </Button>
    </form>
  );
}
