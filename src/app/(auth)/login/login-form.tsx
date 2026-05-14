"use client";

import { useSearchParams } from "next/navigation";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { loginAction, type LoginActionState } from "./actions";

const initialState: LoginActionState = { error: null };

export function LoginForm() {
  const search = useSearchParams();
  // If we were sent here from an invite link, redirect back to the invite
  // page after login so the user can accept. The invite page itself has
  // server-side validation that the token is still good.
  const inviteToken = search.get("invite");
  const next = inviteToken
    ? `/invite/${encodeURIComponent(inviteToken)}`
    : (search.get("next") ?? "/dashboard");
  const prefillEmail = search.get("email") ?? "";
  const [state, formAction, pending] = useActionState(loginAction, initialState);

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="next" value={next} />
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
      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input id="password" name="password" type="password" autoComplete="current-password" required />
      </div>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Logging in…" : "Log in"}
      </Button>
    </form>
  );
}
