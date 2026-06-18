"use client";

import { useSearchParams } from "next/navigation";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { forgotPasswordAction, type ForgotPasswordState } from "./actions";

const initialState: ForgotPasswordState = { error: null, info: null };

export function ForgotPasswordForm() {
  const search = useSearchParams();
  const prefillEmail = search.get("email") ?? "";
  // /reset-password sends users here with ?error=… when their recovery link is
  // expired/invalid, so surface that alongside the form's own validation errors.
  const urlError = search.get("error");
  const [state, formAction, pending] = useActionState(forgotPasswordAction, initialState);

  // Once the link is sent, swap the form for the confirmation so the user isn't
  // tempted to resubmit (and hit the per-hour email rate limit).
  if (state.info) {
    return <p className="text-sm text-foreground/80">{state.info}</p>;
  }

  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          defaultValue={prefillEmail}
          required
        />
      </div>
      {(state.error || urlError) ? (
        <p className="text-sm text-destructive">{state.error || urlError}</p>
      ) : null}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Sending…" : "Send reset link"}
      </Button>
    </form>
  );
}
