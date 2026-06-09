import Link from "next/link";
import type { Metadata } from "next";
import { Check } from "lucide-react";
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
