import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight, Sparkles, ShieldCheck, Zap } from "lucide-react";
import { Logo } from "@/components/ui/logo";
import { PLATFORM_ORDER, PLATFORMS } from "@/lib/handles/platforms";
import { HandleCheckerForm } from "./handle-checker-form";

// PUBLIC, no-auth page (acquisition Lever 3 — a free top-of-funnel SEO tool).
// Match the public marketing surface (homepage / pricing), NOT the app-internal
// UI. Indexable: this is a shareable wedge that should rank for "social handle
// availability checker" queries.
export const metadata: Metadata = {
  title: "Free Social Handle Checker — is your brand name available? · marketingmagic",
  description:
    "Check if your brand name or username is available across all 8 social platforms — X, Instagram, TikTok, YouTube, Bluesky, Threads, Facebook and LinkedIn — in one search. Free, no signup.",
  alternates: { canonical: "/tools/handle-checker" },
  robots: { index: true, follow: true },
  openGraph: {
    title: "Free Social Handle Checker — is your brand name available?",
    description:
      "Check one name across all 8 social platforms in a single search. Free, no signup.",
    url: "/tools/handle-checker",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Free Social Handle Checker — is your brand name available?",
    description: "Check one name across all 8 social platforms in a single search. Free, no signup.",
  },
};

// Three honest selling points for the tool (no fabricated metrics).
const POINTS = [
  {
    icon: Zap,
    title: "All 8 platforms, one search",
    body: "X, Instagram, TikTok, YouTube, Bluesky, Threads, Facebook and LinkedIn — checked together, not one tab at a time.",
  },
  {
    icon: ShieldCheck,
    title: "Honest results",
    body: "Bluesky, TikTok, YouTube and X are verified live. The platforms that hide availability get a one-tap “check it yourself” link — we never fake a result.",
  },
  {
    icon: Sparkles,
    title: "Then build a presence",
    body: "Found your name? marketingmagic plans and publishes on-brand content across every platform you just claimed — from one queue.",
  },
] as const;

export default function HandleCheckerPage() {
  // JSON-LD so the free tool can surface as a rich result for "handle checker"
  // searches — a small SEO edge for an acquisition surface.
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "Social Handle Checker",
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    description:
      "Check if a brand name or username is available across X, Instagram, TikTok, YouTube, Bluesky, Threads, Facebook and LinkedIn.",
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  };

  return (
    <main className="flex min-h-dvh flex-col">
      <script
        type="application/ld+json"
        // Static, trusted object — safe to inline for SEO.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      {/* ─── Nav ─────────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <nav className="container flex h-16 items-center justify-between">
          <Link
            href="/"
            aria-label="marketingmagic home"
            className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <Logo variant="full" size="sm" />
          </Link>
          <div className="flex items-center gap-1 sm:gap-2">
            <Link
              href="/pricing"
              className="inline-flex h-9 items-center rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              Pricing
            </Link>
            <Link
              href="/login"
              className="inline-flex h-9 items-center rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              Log in
            </Link>
            <Link
              href="/signup"
              className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              Sign up
            </Link>
          </div>
        </nav>
      </header>

      {/* ─── Hero + tool ─────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden border-b">
        <div
          aria-hidden
          className="brand-glow pointer-events-none absolute inset-x-0 top-0 -z-10 h-[360px]"
        />
        <div className="container flex flex-col items-center gap-8 py-16 text-center sm:py-20">
          <div className="badge-glow inline-flex items-center gap-2 rounded-full border bg-background/80 px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur">
            <Sparkles
              className="h-3.5 w-3.5"
              style={{ color: "hsl(var(--brand-grad-start))" }}
              aria-hidden
            />
            Free tool · no signup
          </div>

          <h1 className="max-w-3xl text-balance text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
            Is your brand name{" "}
            <span className="brand-gradient-text">available everywhere?</span>
          </h1>
          <p className="max-w-xl text-pretty text-base text-muted-foreground sm:text-lg">
            Check one name across all 8 social platforms in a single search — before you print it
            on a logo. Type a handle and see where it&apos;s free.
          </p>

          {/* The tool itself — full width on the hero so it's the obvious focus. */}
          <div className="mt-2 w-full max-w-3xl text-left">
            <HandleCheckerForm />
          </div>

          {/* Platform strip — names it checks, for scannability + SEO keywords. */}
          <ul className="flex flex-wrap items-center justify-center gap-2 pt-2">
            {PLATFORM_ORDER.map((p) => (
              <li
                key={p}
                className="rounded-full border bg-background/60 px-3 py-1 text-xs font-medium text-muted-foreground"
              >
                {PLATFORMS[p].label}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ─── Why ─────────────────────────────────────────────────────────── */}
      <section className="container py-16">
        <div className="grid gap-6 sm:grid-cols-3">
          {POINTS.map((pt) => (
            <div key={pt.title} className="flex flex-col gap-3 rounded-2xl border bg-card p-6">
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
                <pt.icon
                  className="h-5 w-5"
                  style={{ color: "hsl(var(--brand-grad-start))" }}
                  aria-hidden
                />
              </span>
              <h2 className="text-base font-semibold">{pt.title}</h2>
              <p className="text-sm text-muted-foreground">{pt.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ─── Final CTA ───────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden border-t">
        <div
          aria-hidden
          className="brand-glow pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-[360px] rotate-180"
        />
        <div className="container flex flex-col items-center gap-6 py-20 text-center">
          <h2 className="max-w-2xl text-balance text-3xl font-bold tracking-tight sm:text-4xl">
            Got the name? Now <span className="brand-gradient-text">grow on it.</span>
          </h2>
          <p className="max-w-md text-pretty text-muted-foreground">
            marketingmagic drafts on-brand posts and short-form video, then learns what actually
            works — across every platform you just claimed. See a free preview in 30 seconds.
          </p>
          <div className="flex w-full flex-col items-center gap-3 sm:w-auto sm:flex-row">
            <Link
              href="/start"
              className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:opacity-95 hover:shadow-xl hover:shadow-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:w-auto"
            >
              See a preview plan
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
            <Link
              href="/signup"
              className="inline-flex h-12 w-full items-center justify-center rounded-md border border-input px-6 text-sm font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:w-auto"
            >
              Sign up free
            </Link>
          </div>
        </div>
      </section>

      {/* ─── Footer ──────────────────────────────────────────────────────── */}
      <footer className="border-t">
        <div className="container flex flex-col items-center justify-between gap-4 py-8 text-sm text-muted-foreground sm:flex-row">
          <Logo variant="full" size="sm" className="text-foreground" />
          <div className="flex items-center gap-5">
            <Link href="/pricing" className="transition-colors hover:text-foreground">
              Pricing
            </Link>
            <Link href="/privacy" className="transition-colors hover:text-foreground">
              Privacy
            </Link>
            <Link href="/terms" className="transition-colors hover:text-foreground">
              Terms
            </Link>
            <Link href="/login" className="transition-colors hover:text-foreground">
              Log in
            </Link>
            <Link href="/signup" className="transition-colors hover:text-foreground">
              Sign up
            </Link>
          </div>
          <p>&copy; {new Date().getFullYear()} marketingmagic</p>
        </div>
      </footer>
    </main>
  );
}
