import Link from "next/link";
import {
  ArrowRight,
  Sparkles,
  TrendingUp,
  ShieldCheck,
  Clapperboard,
  Trophy,
  CheckCircle2,
  Wand2,
  CalendarRange,
  Repeat,
} from "lucide-react";
import { Logo } from "@/components/ui/logo";

export const metadata = {
  title: "marketingmagic — the social growth engine that learns what works",
  description:
    "Most tools just schedule posts. marketingmagic drafts on-brand content, ships AI short-form video, and learns which themes actually drive engagement — then doubles down. You stay in control.",
};

// Hero proof-strip stats. Illustrative product framing, not customer metrics.
const HERO_STATS = [
  { value: "7", label: "channels, one queue" },
  { value: "0", label: "posts you didn't approve" },
  { value: "∞", label: "themes it keeps testing" },
] as const;

// The three pillars — ordered by the strategic wedge: learning loop FIRST.
const PILLARS = [
  {
    icon: TrendingUp,
    eyebrow: "The difference",
    title: "It learns what works",
    body: "Every post is measured. A Bayesian model finds the themes that actually move engagement for your audience — and quietly retires the ones that don't. Your calendar gets smarter every week.",
  },
  {
    icon: Clapperboard,
    eyebrow: "Built in",
    title: "AI short-form video",
    body: "Turn a topic into a captioned short — bring your own keys — then publish it everywhere through the same approve-and-go flow as your posts. No separate tool, no export dance.",
  },
  {
    icon: ShieldCheck,
    eyebrow: "On your terms",
    title: "Hybrid-approval autopilot",
    body: "Approve in one tap, or let themes you trust post on their own once they've proven themselves. Automatic when you want it, never when you don't.",
  },
] as const;

// Mocked "winning themes" board — the learning loop made visible. Static,
// illustrative numbers; this is the hero of the differentiator section.
const WINNING_THEMES = [
  { theme: "Behind-the-scenes", lift: "+38%", confidence: 94, leading: true },
  { theme: "Customer wins", lift: "+24%", confidence: 88, leading: false },
  { theme: "Hot takes", lift: "+11%", confidence: 71, leading: false },
  { theme: "Product tips", lift: "−6%", confidence: 64, leading: false },
] as const;

const STEPS = [
  {
    icon: Wand2,
    n: "01",
    title: "Describe your brand once",
    body: "Paste your site or write a short brief. We learn your voice, audience, and what you sell.",
  },
  {
    icon: CalendarRange,
    n: "02",
    title: "Get a full plan",
    body: "A complete, on-voice content calendar across every channel — drafted for you, not generic filler.",
  },
  {
    icon: Repeat,
    n: "03",
    title: "Approve, then improve",
    body: "Review what you like; let the rest publish. The loop measures results and reshapes next week's plan.",
  },
] as const;

const CHANNELS = [
  "X",
  "LinkedIn",
  "Instagram",
  "Threads",
  "Facebook",
  "Bluesky",
  "TikTok",
] as const;

// Illustrative social proof. Replace `quote` blocks with real testimonials as
// they come in; structure is ready for them.
const PROOF = [
  {
    quote:
      "It stopped me from guessing. I can see which themes earn attention and which ones I should drop — the plan basically tunes itself.",
    name: "Founder",
    role: "Early-stage SaaS",
  },
  {
    quote:
      "The approval flow is the whole thing. I trust it with the posts that have proven out, and I still gate everything else.",
    name: "Marketing lead",
    role: "DTC brand",
  },
  {
    quote:
      "Generating the short-form video in the same place I plan posts saved me an entire tool and a freelancer.",
    name: "Solo creator",
    role: "Newsletter + social",
  },
] as const;

export default function HomePage() {
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

      {/* ─── Hero ────────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden">
        <div aria-hidden className="brand-glow pointer-events-none absolute inset-x-0 top-0 -z-10 h-[480px]" />
        <div className="container flex flex-col items-center gap-7 py-20 text-center sm:py-28">
          <div className="inline-flex items-center gap-2 rounded-full border bg-background/80 px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur">
            <Sparkles className="h-3.5 w-3.5" style={{ color: "hsl(var(--brand-grad-start))" }} aria-hidden />
            A growth engine, not another scheduler
          </div>

          <h1 className="max-w-4xl text-balance text-4xl font-bold leading-[1.05] tracking-tight sm:text-6xl">
            Stop scheduling posts.{" "}
            <span className="brand-gradient-text">Start compounding</span> what works.
          </h1>

          <p className="max-w-xl text-pretty text-base text-muted-foreground sm:text-lg">
            marketingmagic drafts on-brand posts, ships AI short-form video, and learns which
            themes actually drive engagement — then doubles down. You just approve.
          </p>

          <div className="flex w-full flex-col items-center gap-3 sm:w-auto sm:flex-row">
            <Link
              href="/start"
              className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:w-auto"
            >
              See a preview plan — 30s, no signup
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
            <Link
              href="/signup"
              className="inline-flex h-12 w-full items-center justify-center rounded-md border border-input px-6 text-sm font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:w-auto"
            >
              Sign up free
            </Link>
          </div>
          <p className="text-xs text-muted-foreground">No credit card required.</p>

          {/* Proof strip */}
          <dl className="mt-6 grid w-full max-w-lg grid-cols-3 gap-4">
            {HERO_STATS.map((s) => (
              <div key={s.label} className="flex flex-col items-center gap-1">
                <dt className="sr-only">{s.label}</dt>
                <dd className="text-3xl font-bold tabular-nums brand-gradient-text">{s.value}</dd>
                <p className="text-xs text-muted-foreground">{s.label}</p>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* ─── Channel marquee ─────────────────────────────────────────────── */}
      <section className="border-y bg-muted/20 py-8">
        <p className="container mb-5 text-center text-xs uppercase tracking-wide text-muted-foreground">
          One queue. Every channel.
        </p>
        <div className="marquee-mask overflow-hidden">
          {/* Two copies of the list inside one track → seamless loop. The
              second copy is aria-hidden so screen readers hear the channels
              once. Reduced-motion users get a static wrapping row (see CSS). */}
          <div className="marquee-track gap-3">
            {[0, 1].map((copy) => (
              <ul
                key={copy}
                aria-hidden={copy === 1 || undefined}
                className="flex shrink-0 items-center gap-3 px-1.5"
              >
                {CHANNELS.map((c) => (
                  <li
                    key={`${copy}-${c}`}
                    className="rounded-full border bg-background px-4 py-2 text-sm font-medium text-foreground/80"
                  >
                    {c}
                  </li>
                ))}
              </ul>
            ))}
          </div>
        </div>
      </section>

      {/* ─── Differentiator: the learning loop, made visible ─────────────── */}
      <section className="border-b">
        <div className="container grid items-center gap-10 py-20 sm:py-28 lg:grid-cols-2 lg:gap-16">
          <div className="space-y-5">
            <p className="label-eyebrow">Why it&apos;s different</p>
            <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
              Your account, getting smarter every week.
            </h2>
            <p className="text-pretty text-muted-foreground">
              Schedulers post and forget. marketingmagic treats every post as a signal. A
              Bayesian model ranks your content themes by the engagement they actually earn,
              flags the confident winners, and feeds them straight back into next week&apos;s
              plan — so you spend your budget on what&apos;s proven, not what you hope.
            </p>
            <ul className="space-y-3 pt-2">
              {[
                "Confidence-scored theme winners, not vanity likes",
                "Underperformers retired automatically",
                "A weekly “what we learned & changed” digest",
              ].map((item) => (
                <li key={item} className="flex items-start gap-3 text-sm">
                  <CheckCircle2
                    className="mt-0.5 h-5 w-5 shrink-0"
                    style={{ color: "hsl(var(--brand-grad-start))" }}
                    aria-hidden
                  />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Winning-themes board — the loop visualised. */}
          <div className="rounded-2xl border bg-card p-6 shadow-sm sm:p-8">
            <div className="mb-6 flex items-center gap-2">
              <Trophy className="h-5 w-5" style={{ color: "hsl(var(--brand-grad-start))" }} aria-hidden />
              <h3 className="text-sm font-semibold">Your winning themes</h3>
              <span className="ml-auto text-xs text-muted-foreground">last 30 days</span>
            </div>
            <ul className="space-y-4">
              {WINNING_THEMES.map((t) => {
                const negative = t.lift.startsWith("−");
                return (
                  <li key={t.theme} className="space-y-1.5">
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="flex items-center gap-2 font-medium">
                        {t.theme}
                        {t.leading ? (
                          <span
                            className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white brand-gradient"
                          >
                            Leading
                          </span>
                        ) : null}
                      </span>
                      <span
                        className="tabular-nums font-semibold"
                        style={{ color: negative ? "hsl(var(--muted-foreground))" : "hsl(var(--positive))" }}
                      >
                        {t.lift}
                      </span>
                    </div>
                    {/* Confidence bar. Width is the model's confidence; the
                        leading theme uses the brand gradient, the rest a muted fill. */}
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div
                        className={t.leading ? "h-full rounded-full brand-gradient" : "h-full rounded-full bg-foreground/25"}
                        style={{ width: `${t.confidence}%` }}
                      />
                    </div>
                    <p className="text-[11px] text-muted-foreground tabular-nums">
                      {t.confidence}% confidence
                    </p>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </section>

      {/* ─── Three pillars ───────────────────────────────────────────────── */}
      <section className="border-b bg-muted/20">
        <div className="container py-20 sm:py-28">
          <div className="mx-auto max-w-2xl text-center">
            <p className="label-eyebrow">What you get</p>
            <h2 className="mt-2 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
              Plan, publish, and improve — in one flow.
            </h2>
          </div>
          <div className="mt-12 grid gap-5 lg:grid-cols-3">
            {PILLARS.map(({ icon: Icon, eyebrow, title, body }) => (
              <div
                key={title}
                className="card-hover group rounded-2xl border bg-card p-7 text-left"
              >
                <span
                  className="flex h-11 w-11 items-center justify-center rounded-xl transition-transform duration-200 group-hover:scale-105"
                  style={{
                    backgroundColor: "hsl(var(--brand-grad-start) / 0.1)",
                    color: "hsl(var(--brand-grad-start))",
                  }}
                >
                  <Icon className="h-5 w-5" aria-hidden />
                </span>
                <p className="mt-5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {eyebrow}
                </p>
                <h3 className="mt-1 text-lg font-semibold">{title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── AI video callout ────────────────────────────────────────────── */}
      <section className="border-b">
        <div className="container py-20 sm:py-28">
          <div className="brand-gradient relative flex flex-col items-center gap-6 overflow-hidden rounded-3xl border px-6 py-14 text-center text-white sm:px-12">
            <span
              aria-hidden
              className="pointer-events-none absolute -right-10 -top-10 h-48 w-48 rounded-full bg-white/10 blur-2xl"
            />
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/15">
              <Clapperboard className="h-6 w-6" aria-hidden />
            </span>
            <h2 className="max-w-xl text-balance text-2xl font-semibold tracking-tight sm:text-3xl">
              Short-form video, generated and published in the same place.
            </h2>
            <p className="max-w-lg text-pretty text-sm text-white/85 sm:text-base">
              Turn a topic into a captioned short with your own keys — then send it to every
              channel through the same approve-and-go flow as your posts.
            </p>
            <Link
              href="/signup"
              className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-white px-6 text-sm font-medium text-foreground transition-transform hover:scale-[1.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
            >
              Try it free
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </div>
        </div>
      </section>

      {/* ─── How it works ────────────────────────────────────────────────── */}
      <section className="border-b bg-muted/20">
        <div className="container py-20 sm:py-28">
          <div className="mx-auto max-w-2xl text-center">
            <p className="label-eyebrow">How it works</p>
            <h2 className="mt-2 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
              Set up once. Stay in front of your audience.
            </h2>
          </div>
          <ol className="mx-auto mt-12 grid max-w-5xl gap-5 sm:grid-cols-3">
            {STEPS.map(({ icon: Icon, n, title, body }) => (
              <li key={n} className="relative rounded-2xl border bg-card p-7">
                <span className="absolute right-6 top-6 text-2xl font-bold tabular-nums text-foreground/10">
                  {n}
                </span>
                <span
                  className="flex h-10 w-10 items-center justify-center rounded-xl"
                  style={{
                    backgroundColor: "hsl(var(--brand-grad-start) / 0.1)",
                    color: "hsl(var(--brand-grad-start))",
                  }}
                >
                  <Icon className="h-5 w-5" aria-hidden />
                </span>
                <h3 className="mt-5 font-semibold">{title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ─── Social proof ────────────────────────────────────────────────── */}
      <section className="border-b">
        <div className="container py-20 sm:py-28">
          <div className="mx-auto max-w-2xl text-center">
            <p className="label-eyebrow">In their words</p>
            <h2 className="mt-2 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
              Built for people who&apos;d rather grow than post.
            </h2>
          </div>
          <div className="mt-12 grid gap-5 lg:grid-cols-3">
            {PROOF.map((p) => (
              <figure key={p.name + p.role} className="flex flex-col rounded-2xl border bg-card p-7">
                <blockquote className="text-sm leading-relaxed text-foreground/90">
                  “{p.quote}”
                </blockquote>
                <figcaption className="mt-5 flex items-center gap-3 border-t pt-4 text-sm">
                  <span
                    aria-hidden
                    className="flex h-9 w-9 items-center justify-center rounded-full text-xs font-semibold text-white brand-gradient"
                  >
                    {p.name.slice(0, 1)}
                  </span>
                  <span>
                    <span className="block font-medium">{p.name}</span>
                    <span className="block text-xs text-muted-foreground">{p.role}</span>
                  </span>
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      </section>

      {/* ─── Final CTA ───────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden">
        <div aria-hidden className="brand-glow pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-[420px] rotate-180" />
        <div className="container flex flex-col items-center gap-6 py-24 text-center">
          <h2 className="max-w-2xl text-balance text-3xl font-bold tracking-tight sm:text-5xl">
            Put your growth on autopilot — and keep your hand on the wheel.
          </h2>
          <p className="max-w-md text-pretty text-muted-foreground">
            See what a week of on-brand, data-tuned content looks like for your business. No
            signup, 30 seconds.
          </p>
          <div className="flex w-full flex-col items-center gap-3 sm:w-auto sm:flex-row">
            <Link
              href="/start"
              className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:w-auto"
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
