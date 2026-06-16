// Shared public marketing shell (nav + footer) for the best-time-to-post tool.
//
// Kept local to this dir on purpose: the task scopes all files under
// /tools/best-time-to-post/, and a /tools/layout.tsx is owned by integration
// (another agent works under /tools/ in parallel). This reuses the exact nav +
// footer markup of the home and pricing marketing pages so the surface matches
// the public design system, not the app-internal UI.

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Logo } from "@/components/ui/logo";

const FOOTER_YEAR = new Date().getFullYear();

export function ToolShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col">
      {/* ─── Nav ─────────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <nav className="container flex h-16 items-center justify-between gap-2">
          <Link
            href="/"
            aria-label="marketingmagic home"
            className="shrink-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <span className="inline-flex sm:hidden">
              <Logo variant="icon" size="sm" />
            </span>
            <span className="hidden sm:inline-flex">
              <Logo variant="full" size="sm" />
            </span>
          </Link>
          <div className="flex shrink-0 items-center gap-0.5 sm:gap-2">
            <Link
              href="/pricing"
              className="inline-flex h-9 items-center whitespace-nowrap rounded-md px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:px-3"
            >
              Pricing
            </Link>
            <Link
              href="/login"
              className="inline-flex h-9 items-center whitespace-nowrap rounded-md px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:px-3"
            >
              Log in
            </Link>
            <Link
              href="/signup"
              className="inline-flex h-9 items-center whitespace-nowrap rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:px-4"
            >
              Sign up
            </Link>
          </div>
        </nav>
      </header>

      {children}

      {/* ─── Footer ──────────────────────────────────────────────────────── */}
      <footer className="border-t">
        <div className="container flex flex-col items-center justify-between gap-4 py-8 text-sm text-muted-foreground sm:flex-row">
          <Logo variant="full" size="sm" className="text-foreground" />
          <div className="flex items-center gap-5">
            <Link href="/tools/best-time-to-post" className="transition-colors hover:text-foreground">
              Best time to post
            </Link>
            <Link href="/pricing" className="transition-colors hover:text-foreground">
              Pricing
            </Link>
            <Link href="/privacy" className="transition-colors hover:text-foreground">
              Privacy
            </Link>
            <Link href="/terms" className="transition-colors hover:text-foreground">
              Terms
            </Link>
          </div>
          <p>&copy; {FOOTER_YEAR} marketingmagic</p>
        </div>
      </footer>
    </main>
  );
}

// The signup-conversion call to action shared by both the index and the
// per-platform pages. Brand-gradient panel matching the marketing CTAs.
export function SignupCta({
  headline,
  body,
}: {
  headline: string;
  body: string;
}) {
  return (
    <div className="brand-gradient relative flex flex-col items-center gap-5 overflow-hidden rounded-3xl border px-6 py-12 text-center text-white sm:px-12">
      <span
        aria-hidden
        className="pointer-events-none absolute -right-10 -top-10 h-48 w-48 rounded-full bg-white/10 blur-2xl"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute -bottom-12 -left-8 h-56 w-56 rounded-full bg-white/10 blur-2xl"
      />
      <h2 className="relative z-10 max-w-xl text-balance text-2xl font-semibold tracking-tight sm:text-3xl">
        {headline}
      </h2>
      <p className="relative z-10 max-w-lg text-pretty text-sm text-white/90 sm:text-base">{body}</p>
      <Link
        href="/start"
        className="relative z-10 inline-flex h-11 items-center justify-center gap-2 rounded-md bg-white px-6 text-sm font-medium text-foreground transition-transform hover:scale-[1.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
      >
        Get posting times optimized for YOUR audience
        <ArrowRight className="h-4 w-4" aria-hidden />
      </Link>
      <p className="relative z-10 text-xs text-white/80">Free to start · no credit card · 30s to a plan.</p>
    </div>
  );
}
