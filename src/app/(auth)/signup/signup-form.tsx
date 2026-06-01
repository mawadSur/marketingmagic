"use client";

import { useSearchParams } from "next/navigation";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signupAction, type SignupActionState } from "./actions";

const initialState: SignupActionState = { error: null, info: null };

export function SignupForm() {
  const search = useSearchParams();
  const invite = search.get("invite") ?? "";
  const prefillEmail = search.get("email") ?? "";
  // PLG: a ?ref=<code> arriving on the signup URL is carried through as a hidden
  // field; the action stashes it in a cookie for attribution at workspace
  // creation. Ignored for invite signups (they join, not create).
  const ref = search.get("ref") ?? "";
  const [state, formAction, pending] = useActionState(signupAction, initialState);

  return (
    <form action={formAction} className="space-y-4">
      {invite ? <input type="hidden" name="invite" value={invite} /> : null}
      {!invite && ref ? <input type="hidden" name="ref" value={ref} /> : null}
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
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
        />
      </div>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.info ? <p className="text-sm text-muted-foreground">{state.info}</p> : null}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Creating account…" : "Sign up"}
      </Button>
    </form>
  );
}
