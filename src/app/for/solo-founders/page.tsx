import Link from "next/link";
import type { Metadata } from "next";
import {
  ArrowRight,
  Sparkles,
  Clock4,
  Mic,
  Clapperboard,
  TrendingUp,
  ShieldCheck,
  CheckCircle2,
  Rocket,
  ClipboardPaste,
  CalendarRange,
  Repeat,
} from "lucide-react";
import { ToolShell, SignupCta } from "@/app/tools/best-time-to-post/shell";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Social media on autopilot for solo founders · marketingmagic",
  description:
    "You're building a company, not a content calendar. marketingmagic turns your build updates into consistent build-in-public posts and AI short-form video across 8 channels — in your voice, led by X — and learns what works, so you keep shipping.",
  alternates: { canonical: "/for/solo-founders" },
  robots: { index: true, follow: true },
  openGraph: {
    title: "Social media on autopilot for solo founders",
    description:
      "Turn your build updates into a week of build-in-public posts and AI video across every channel — in your voice. Keep shipping; let the loop do the marketing.",
    type: "website",
  },
};

// The founder's week, three beats: paste the build → get a week of posts → it
// publishes and learns. Lead with X because that's where build-in-public lives.
const WEEK_STEPS = [
  {
    icon: ClipboardPaste,
    n: "01",
    title: "Paste your build updates",
    body: "Drop in what you shipped this week — a commit log, a changelog, a few rough notes. No blank page, no \"what do I even post.\"",
  },
  {
    icon: CalendarRange,
    n: "02",
    title: "Get a week of build-in-public posts",
    body: "A full week drafted in your voice — X threads leading the way, plus LinkedIn, Threads and the rest — each reframed for how that channel reads.",
  },
  {
    icon: Repeat,
    n: "03",
    title: "It publishes — and learns",
    body: "Approve in a tap (or let proven themes auto-post), and the loop measures what landed so next week leans into what your audience actually rewards.",
  },
] as const;

// The real founder objections. Honest, product-grounded answers.
const OBJECTIONS = [
  {
    icon: Clock4,
    title: "“I don't have time for this.”",
    body: "That's the point. You're already writing commits, ship notes and Slack updates — paste those in and a week of posts comes back drafted. Skim and approve over coffee; you spend minutes, not hours.",
  },
  {
    icon: Mic,
    title: "“I'm a founder, not a marketer.”",
    body: "You don't have to become one. It learns your voice from your site and your updates, drafts in it, and the learning loop handles the strategy part — ranking what works so you don't have to guess.",
  },
  {
    icon: Sparkles,
    title: "“Self-promo feels cringe.”",
    body: "Build-in-public isn't bragging — it's narrating the work. The drafts read like a founder sharing progress, not an ad. You stay in control of every word, and nothing posts that you'd be embarrassed to ship.",
  },
] as const;

// Value props, grounded in the actual product. Learning loop first (the wedge),
// then plan-gen in your voice, AI video, and the channel spread led by X.
const VALUE_PROPS = [
  {
    icon: TrendingUp,
    eyebrow: "The difference",
    title: "It learns what works",
    body: "Every post is a signal. A Bayesian model ranks the themes your audience actually engages with and quietly retires the duds — so your build-in-public gets sharper every single week.",
  },
  {
    icon: Sparkles,
    eyebrow: "In your voice",
    title: "AI plan-gen, not generic filler",
    body: "Describe your product once. The planner writes a full, on-voice calendar from your real updates — founder-native posts that sound like you, not a marketing intern with a thesaurus.",
  },
  {
    icon: Clapperboard,
    eyebrow: "Built in",
    title: "AI short-form video",
    body: "Turn a milestone into a captioned short — bring your own keys — and publish it everywhere through the same approve-and-go flow. One demo clip, every channel, no separate editor.",
  },
  {
    icon: ShieldCheck,
    eyebrow: "On your terms",
    title: "8 channels, led by X",
    body: "X, LinkedIn, Threads, Instagram, Facebook, Bluesky, TikTok and YouTube from one queue — formatted per channel. Approve everything by default, or let trusted themes run on autopilot.",
  },
] as const;

// Honest, capability-true proof points (no fabricated customer counts).
const FOUNDER_STATS = [
  { value: "8", label: "channels, one queue" },
  { value: "X", label: "leads your build-in-public" },
  { value: "1-tap", label: "approve or auto-post" },
  { value: "30s", label: "to a preview week" },
] as const;

export default function SoloFoundersPage() {
  return (
    <ToolShell>
      {/* ─── Hero ────────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden border-b">
        <div aria-hidden className="brand-glow pointer-events-none absolute inset-x-0 top-0 -z-10 h-[420px]" />
        <div className="container flex flex-col items-center gap-7 py-20 text-center sm:py-28">
          <div className="badge-glow inline-flex items-center gap-2 rounded-full border bg-background/80 px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur">
            <Rocket className="h-3.5 w-3.5" style={{ color: "hsl(var(--brand-grad-start))" }} aria-hidden />
            For solo founders &amp; build-in-public
          </div>

          <h1 className="max-w-4xl text-balance text-4xl font-bold leading-[1.05] tracking-tight sm:text-6xl">
            You&apos;re building a company,{" "}
            <span className="brand-gradient-text">not a content calendar.</span>
          </h1>

          <p className="max-w-2xl text-pretty text-base text-muted-foreground sm:text-lg">
            marketingmagic turns your build into consistent posts and AI short-form video across
            every channel — in your voice, led by X — and learns what actually works. So you keep
            shipping while your marketing compounds in the background.
          </p>

          <div className="flex w-full flex-col items-center gap-3 sm:w-auto sm:flex-row">
            <Link
              href="/start"
              className="btn-magic inline-flex h-12 w-full items-center justify-center gap-2 rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:opacity-95 hover:shadow-xl hover:shadow-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:w-auto"
            >
              See a week of your posts — 30s, no signup
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
            <Link
              href="/signup"
              className="inline-flex h-12 w-full items-center justify-center rounded-md border border-input px-6 text-sm font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:w-auto"
            >
              Sign up free
            </Link>
          </div>
          <p className="text-xs text-muted-foreground">Free to start · no credit card · built for one-person teams.</p>

          {/* Proof strip — capability-true, no fake metrics. */}
          <dl className="mt-6 grid w-full max-w-2xl grid-cols-2 gap-6 sm:grid-cols-4">
            {FOUNDER_STATS.map((s) => (
              <div key={s.label} className="flex flex-col items-center gap-1">
                <dt className="sr-only">{s.label}</dt>
                <dd className="text-3xl font-bold tabular-nums brand-gradient-text">{s.value}</dd>
                <p className="text-xs text-muted-foreground">{s.label}</p>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* ─── How it fits a founder's week ────────────────────────────────── */}
      <section className="border-b bg-muted/20">
        <div className="container py-20 sm:py-28">
          <div className="mx-auto max-w-2xl text-center">
            <p className="label-eyebrow">How it fits your week</p>
            <h2 className="mt-2 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
              From build log to build-in-public — without leaving the work.
            </h2>
            <p className="mt-3 text-pretty text-muted-foreground">
              You ship. Paste what changed. A week of posts comes back, goes out, and gets smarter.
              That&apos;s the whole loop.
            </p>
          </div>
          <ol className="mx-auto mt-12 grid max-w-5xl gap-5 sm:grid-cols-3">
            {WEEK_STEPS.map(({ icon: Icon, n, title, body }) => (
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

      {/* ─── Objection handling ──────────────────────────────────────────── */}
      <section className="border-b">
        <div className="container py-20 sm:py-28">
          <div className="mx-auto max-w-2xl text-center">
            <p className="label-eyebrow">The honest part</p>
            <h2 className="mt-2 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
              The reasons founders don&apos;t post — answered.
            </h2>
          </div>
          <div className="mx-auto mt-12 grid max-w-5xl gap-5 lg:grid-cols-3">
            {OBJECTIONS.map(({ icon: Icon, title, body }) => (
              <div key={title} className="rounded-2xl border bg-card p-7 text-left">
                <span
                  className="flex h-11 w-11 items-center justify-center rounded-xl"
                  style={{
                    backgroundColor: "hsl(var(--brand-grad-start) / 0.1)",
                    color: "hsl(var(--brand-grad-start))",
                  }}
                >
                  <Icon className="h-5 w-5" aria-hidden />
                </span>
                <h3 className="mt-5 text-lg font-semibold">{title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── Value props ─────────────────────────────────────────────────── */}
      <section className="border-b bg-muted/20">
        <div className="container py-20 sm:py-28">
          <div className="mx-auto max-w-2xl text-center">
            <p className="label-eyebrow">Why it works for one-person teams</p>
            <h2 className="mt-2 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
              A marketing team&apos;s output, run by you alone.
            </h2>
          </div>
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {VALUE_PROPS.map(({ icon: Icon, eyebrow, title, body }) => (
              <div
                key={title}
                className="card-hover group rounded-2xl border bg-card p-7 text-left transition-transform hover:-translate-y-1"
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

          {/* Reassurance row — what a founder cares about before trusting it. */}
          <ul className="mx-auto mt-10 flex max-w-3xl flex-wrap items-center justify-center gap-x-6 gap-y-3 text-sm text-muted-foreground">
            {[
              "Nothing posts without your say-so",
              "Your voice, learned from your updates",
              "One subscription, all your projects",
            ].map((item) => (
              <li key={item} className="flex items-center gap-2">
                <CheckCircle2
                  className="h-4 w-4 shrink-0"
                  style={{ color: "hsl(var(--brand-grad-start))" }}
                  aria-hidden
                />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ─── Closing CTA ─────────────────────────────────────────────────── */}
      <section className="container py-20 sm:py-28">
        <SignupCta
          headline="Keep shipping. Let marketingmagic do the marketing."
          body="Paste what you built this week and watch a full slate of build-in-public posts come back in your voice — X first, every channel covered. 30 seconds, no signup."
        />
      </section>
    </ToolShell>
  );
}
