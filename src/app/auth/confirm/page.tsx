"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { safeInternalPath } from "@/lib/auth/redirect";
import { friendlyAuthError } from "@/lib/auth/messages";
import { Logo } from "@/components/ui/logo";

// Client-side finaliser for auth links whose tokens/errors live in the URL #hash
// (implicit flow), which the server-side /auth/callback route can't see. The
// browser Supabase client parses the hash on init (detectSessionInUrl), so we
// just wait for a session to appear and forward to `next` — or show a readable
// error instead of the blank page the old flow produced.
function Finalise() {
  const search = useSearchParams();
  const next = safeInternalPath(search.get("next"));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const DEAD_LINK =
      "We couldn't confirm your account from this link — it may have expired or already been used. Request a new one below.";
    let settled = false;
    const go = (path: string) => {
      if (settled) return;
      settled = true;
      // Full navigation (not router.push) so the server sees the freshly written
      // session cookies on the next request.
      window.location.assign(path);
    };
    const fail = (msg: string) => {
      if (settled) return;
      settled = true;
      setError(msg);
    };

    const rawHash = typeof window !== "undefined" ? window.location.hash : "";
    const hash = new URLSearchParams(rawHash.startsWith("#") ? rawHash.slice(1) : rawHash);

    // A hash error (#error=access_denied&error_description=…) means the link is
    // dead — surface it right away (deferred to a macrotask so we never setState
    // synchronously inside the effect body) instead of waiting on a session.
    const hashError = hash.get("error_description") ?? hash.get("error");
    if (hashError) {
      const id = setTimeout(() => fail(friendlyAuthError(hashError)), 0);
      return () => clearTimeout(id);
    }

    const supabase = supabaseBrowser();

    // Did this link actually carry confirmation tokens in the fragment? If not,
    // the page was reached without one (direct nav / stale tab). Don't hijack an
    // already-authenticated visitor into onboarding — send them to /dashboard,
    // and anyone else off to request a fresh link.
    const hasTokens = hash.has("access_token") || hash.has("refresh_token");
    if (!hasTokens) {
      const id = setTimeout(() => {
        supabase.auth.getSession().then(({ data }) => {
          if (data.session) go("/dashboard");
          else fail(DEAD_LINK);
        });
      }, 0);
      return () => clearTimeout(id);
    }

    // Tokens present — wait for @supabase/ssr to parse the fragment and persist
    // the session. detectSessionInUrl does a network round-trip (GET /user), so a
    // cold mobile connection can take several seconds; give it real headroom.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) go(next);
    });
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) go(next);
    });
    // Backstop: before declaring the link dead, do one final session check — the
    // round-trip may simply have outrun the timer rather than failed.
    const timer = setTimeout(() => {
      supabase.auth.getSession().then(({ data }) => {
        if (data.session) go(next);
        else fail(DEAD_LINK);
      });
    }, 10000);

    return () => {
      clearTimeout(timer);
      sub.subscription.unsubscribe();
    };
  }, [next]);

  if (error) {
    return (
      <div className="w-full max-w-sm space-y-6 text-center">
        <Logo variant="full" size="lg" className="mx-auto" />
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">Link didn&apos;t work</h1>
          <p className="text-sm text-foreground/80">{error}</p>
        </div>
        <div className="flex flex-col gap-2">
          <Link
            href="/login"
            className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go to log in
          </Link>
          <Link
            href="/signup"
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            Create a new account
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-sm space-y-4 text-center">
      <Logo variant="full" size="lg" className="mx-auto" />
      <div
        className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground"
        role="status"
        aria-label="Confirming"
      />
      <p className="text-sm text-muted-foreground">Confirming your account…</p>
    </div>
  );
}

export default function AuthConfirmPage() {
  return (
    <main className="container flex min-h-screen items-center justify-center py-16">
      <Suspense fallback={null}>
        <Finalise />
      </Suspense>
    </main>
  );
}
