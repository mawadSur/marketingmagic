"use client";

import Link from "next/link";
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
  // /auth/callback forwards failed confirmation/recovery links here as ?error=,
  // and successful flows (e.g. password reset) as ?message=. Surface both — the
  // old form swallowed them, which is what made a dead link look like a blank
  // page. The action's own error takes precedence over a stale URL error.
  const urlError = search.get("error");
  const message = search.get("message");
  const [state, formAction, pending] = useActionState(loginAction, initialState);
  const error = state.error || urlError;

  // Carry the typed/prefilled email into the forgot-password link so it prefills.
  const forgotHref = prefillEmail
    ? `/forgot-password?email=${encodeURIComponent(prefillEmail)}`
    : "/forgot-password";

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="next" value={next} />
      {message ? (
        <p className="rounded-md bg-primary/10 px-3 py-2 text-sm text-foreground">{message}</p>
      ) : null}
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
        <div className="flex items-center justify-between">
          <Label htmlFor="password">Password</Label>
          <Link
            href={forgotHref}
            className="rounded-sm text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            Forgot password?
          </Link>
        </div>
        <Input id="password" name="password" type="password" autoComplete="current-password" required />
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Logging in…" : "Log in"}
      </Button>
    </form>
  );
}
