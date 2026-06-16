import Link from "next/link";
import type { Metadata } from "next";
import { Check, X, Sparkles } from "lucide-react";
import { TIERS, aiCreditsLabel, type PlanId } from "@/lib/billing/tiers";
import { Logo } from "@/components/ui/logo";

export const metadata: Metadata = {
  title: "Pricing — marketingmagic",
  description:
    "Simple plans for solo creators to agencies. Unlimited AI writing on every paid tier, AI images + short-form video, and multi-workspace on Agency. Start free.",
};

export const dynamic = "force-static";

// Display order of the ladder (the TIERS map is keyed by enum id, not order).
// Free first → up to Agency. "Creator" (founder) is the highlighted middle.
const ORDER: PlanId[] = ["hobby", "pro", "founder", "agency"];
const HIGHLIGHT: PlanId = "founder";

// One human line for the channel limit (the cap that drives the workspace +
// connect paywalls), so the table answers "how many channels do I get?".
function channelsLabel(channels: number): string {
  if (channels === -1) return "Unlimited channels";
  return `${channels} connected channel${channels === 1 ? "" : "s"}`;
}

// AI-writing line — unlimited on every paid tier, finite only on Free.
function writingLabel(postsPerMonth: number): string {
  return postsPerMonth === -1 ? "Unlimited AI writing" : `${postsPerMonth} generated posts / month`;
}

export default function PricingPage() {
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

      {/* ─── Header ──────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden border-b">
        <div aria-hidden className="brand-glow pointer-events-none absolute inset-x-0 top-0 -z-10 h-[320px]" />
        <div className="container flex flex-col items-center gap-4 py-16 text-center sm:py-20">
          <h1 className="max-w-3xl text-balance text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
            Pricing that <span className="brand-gradient-text">scales with you</span>
          </h1>
          <p className="max-w-xl text-pretty text-base text-muted-foreground sm:text-lg">
            Start free. Unlimited AI writing on every paid plan, plus AI images and short-form
            video. One subscription covers all of your workspaces.
          </p>
        </div>
      </section>

      {/* ─── Plans ───────────────────────────────────────────────────────── */}
      <section className="container py-14">
        <div className="grid gap-6 lg:grid-cols-4">
          {ORDER.map((id) => {
            const tier = TIERS[id];
            const highlighted = id === HIGHLIGHT;
            const credits = aiCreditsLabel(id);
            return (
              <div
                key={id}
                className={
                  "relative flex flex-col rounded-2xl border p-6 " +
                  (highlighted ? "border-primary shadow-lg" : "bg-muted/10")
                }
              >
                {highlighted ? (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-primary px-3 py-0.5 text-xs font-medium text-primary-foreground">
                    Most popular
                  </span>
                ) : null}

                <div className="space-y-1">
                  <h2 className="text-lg font-semibold">{tier.name}</h2>
                  <div className="flex items-baseline gap-1">
                    <span className="text-3xl font-bold tabular-nums">${tier.priceMonthly}</span>
                    <span className="text-sm text-muted-foreground">/mo</span>
                  </div>
                  <p className="min-h-[2.5rem] text-sm text-muted-foreground">{tier.blurb}</p>
                </div>

                <Link
                  href="/signup"
                  className={
                    "mt-4 inline-flex h-10 items-center justify-center rounded-md px-4 text-sm font-medium transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 " +
                    (highlighted
                      ? "bg-primary text-primary-foreground"
                      : "border border-input bg-background hover:bg-accent")
                  }
                >
                  {id === "hobby" ? "Start free" : `Get ${tier.name}`}
                </Link>

                <ul className="mt-6 space-y-2.5 text-sm">
                  <Feature>{channelsLabel(tier.limits.channels)}</Feature>
                  <Feature>{writingLabel(tier.limits.postsPerMonth)}</Feature>
                  <Feature>
                    {credits === "0" ? "No AI image / video" : `${credits} AI credits / mo (images + video)`}
                  </Feature>
                  {tier.features.map((f) => (
                    <Feature key={f}>{f}</Feature>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>

        <p className="mt-8 text-center text-sm text-muted-foreground">
          Need something custom?{" "}
          <a className="underline underline-offset-4" href="mailto:mawad10101@gmail.com">
            Contact us
          </a>
          .
        </p>
      </section>

      {/* ─── Us vs. typical schedulers ───────────────────────────────────── */}
      <ComparisonBox />

      {/* ─── Footer ──────────────────────────────────────────────────────── */}
      <footer className="mt-auto border-t">
        <div className="container flex flex-col items-center justify-between gap-4 py-8 text-sm text-muted-foreground sm:flex-row">
          <Logo variant="full" size="sm" className="text-foreground" />
          <div className="flex items-center gap-5">
            <Link href="/" className="transition-colors hover:text-foreground">
              Home
            </Link>
            <Link href="/privacy" className="transition-colors hover:text-foreground">
              Privacy
            </Link>
            <Link href="/terms" className="transition-colors hover:text-foreground">
              Terms
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

function Feature({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
      <span>{children}</span>
    </li>
  );
}

// ─── Us vs. typical schedulers ──────────────────────────────────────────────
// The "true value" story: most tools stop at scheduling — you still write every
// post, export video from somewhere else, and stare at vanity dashboards. The
// rows below map 1:1 to our real differentiators (see the homepage pillars +
// docs/designs/postiz-competitive-roadmap.md): unlimited AI writing, built-in
// video, the Bayesian learning loop, voice profile, hybrid autopilot, and one
// bill for every brand. "Typical schedulers" is deliberately generic — an
// honest stand-in for Buffer/Hootsuite/Later-style tools, no fabricated claims
// about a named competitor.
const COMPARE: ReadonlyArray<{
  feature: string;
  them: { has: boolean; note: string };
  us: { note: string };
}> = [
  {
    feature: "Schedule across every channel",
    them: { has: true, note: "Often billed per channel" },
    us: { note: "All 8, one queue" },
  },
  {
    feature: "Writes the content for you",
    them: { has: false, note: "You write every post" },
    us: { note: "Unlimited on-brand AI writing" },
  },
  {
    feature: "AI short-form video, built in",
    them: { has: false, note: "Separate tool + export dance" },
    us: { note: "Same approve-and-go flow" },
  },
  {
    feature: "Learns what actually works",
    them: { has: false, note: "Vanity dashboards only" },
    us: { note: "Bayesian theme-winner loop" },
  },
  {
    feature: "A voice that sounds like you",
    them: { has: false, note: "Generic templates" },
    us: { note: "Voice profile that evolves" },
  },
  {
    feature: "Hands-off autopilot",
    them: { has: false, note: "Manual, every single time" },
    us: { note: "Hybrid approval — you stay in control" },
  },
  {
    feature: "Every brand on one bill",
    them: { has: false, note: "Pay per seat / per brand" },
    us: { note: "One subscription covers all" },
  },
];

function ComparisonBox() {
  return (
    <section className="container pb-16 sm:pb-20">
      <div className="mx-auto max-w-4xl">
        <div className="mb-8 text-center">
          <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            The true value
          </p>
          <h2 className="mt-2 text-balance text-2xl font-bold tracking-tight sm:text-3xl">
            Most tools just <span className="text-muted-foreground">schedule</span> posts.
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-pretty text-sm text-muted-foreground sm:text-base">
            marketingmagic writes them, ships the video, and learns what works — so your
            monthly spend buys <span className="font-medium text-foreground">growth</span>,
            not another calendar.
          </p>
        </div>

        <div className="relative overflow-hidden rounded-2xl border bg-muted/10">
          <div
            aria-hidden
            className="brand-glow pointer-events-none absolute inset-x-0 top-0 -z-10 h-40"
          />

          {/* Column headers */}
          <div className="grid grid-cols-2 gap-px border-b bg-border/60 text-sm font-semibold sm:grid-cols-[1.6fr_1fr_1fr]">
            <div className="hidden bg-muted/10 px-5 py-4 sm:block" aria-hidden />
            <div className="bg-muted/10 px-4 py-4 text-center text-muted-foreground sm:px-5 sm:text-left">
              Typical schedulers
            </div>
            <div className="flex items-center justify-center gap-1.5 bg-background px-4 py-4 sm:px-5 sm:justify-start">
              <Sparkles className="h-4 w-4 shrink-0 text-primary" aria-hidden />
              <span className="brand-gradient-text font-bold">marketingmagic</span>
            </div>
          </div>

          {/* Rows */}
          <dl className="divide-y divide-border">
            {COMPARE.map((row) => (
              <div
                key={row.feature}
                className="grid grid-cols-2 items-stretch gap-px bg-border/60 sm:grid-cols-[1.6fr_1fr_1fr]"
              >
                <dt className="col-span-2 bg-muted/10 px-4 pb-1 pt-4 text-sm font-medium sm:col-span-1 sm:py-5 sm:px-5">
                  {row.feature}
                </dt>
                <dd className="flex items-start gap-2 bg-muted/10 px-4 pb-4 pt-1 text-sm text-muted-foreground sm:py-5 sm:px-5 sm:pt-5">
                  {row.them.has ? (
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  ) : (
                    <X className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/50" aria-hidden />
                  )}
                  <span>
                    <span className="sr-only">
                      {row.them.has ? "Typical schedulers: yes — " : "Typical schedulers: no — "}
                    </span>
                    {row.them.note}
                  </span>
                </dd>
                <dd className="flex items-start gap-2 bg-primary/[0.04] px-4 pb-4 pt-1 text-sm font-medium text-foreground sm:py-5 sm:px-5 sm:pt-5">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                  <span>
                    <span className="sr-only">marketingmagic: yes — </span>
                    {row.us.note}
                  </span>
                </dd>
              </div>
            ))}
          </dl>

          {/* Footer CTA */}
          <div className="flex flex-col items-center gap-3 border-t bg-background px-5 py-6 text-center sm:flex-row sm:justify-between sm:text-left">
            <p className="text-sm text-muted-foreground">
              Unlimited writing, AI video, and a calendar that gets smarter every week.
            </p>
            <Link
              href="/signup"
              className="inline-flex h-10 shrink-0 items-center justify-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              Start free
            </Link>
          </div>
        </div>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          &ldquo;Typical schedulers&rdquo; reflects common Buffer / Hootsuite / Later-style
          plans. Features and pricing vary by tool.
        </p>
      </div>
    </section>
  );
}
