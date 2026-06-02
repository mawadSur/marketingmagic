import Link from "next/link";
import {
  Sparkles,
  CalendarRange,
  ShieldCheck,
  LineChart,
  Clapperboard,
  ArrowRight,
} from "lucide-react";

export const metadata = {
  title: "marketingmagic — social media on autopilot",
  description:
    "Auto-generate on-brand posting plans, schedule across every channel, and let the data pick your winners. You just approve.",
};

const FEATURES = [
  {
    icon: CalendarRange,
    title: "Auto-generated posting plans",
    body: "Describe your brand once. Get a full calendar of on-brand posts across every channel — drafted, not generic.",
  },
  {
    icon: ShieldCheck,
    title: "Hybrid-approval publishing",
    body: "Approve in one tap, or let trusted themes post on their own. Automatic when you want it, never when you don't.",
  },
  {
    icon: LineChart,
    title: "Data-driven iteration",
    body: "Every post is measured. marketingmagic doubles down on the themes that actually drive engagement — and drops the rest.",
  },
];

const STEPS = [
  { n: "1", title: "Connect your channels", body: "Link the platforms you post to in a couple of clicks." },
  { n: "2", title: "Generate a plan", body: "A brand brief becomes a full, on-voice content calendar." },
  { n: "3", title: "Approve & autopilot", body: "Review what you like; let the rest publish on schedule." },
];

const CHANNELS = ["X", "LinkedIn", "Instagram", "Threads", "Facebook", "Bluesky", "TikTok"];

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col">
      {/* Nav */}
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <nav className="container flex h-16 items-center justify-between">
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-600 to-violet-600 text-white">
              <Sparkles className="h-4 w-4" aria-hidden />
            </span>
            marketingmagic
          </Link>
          <div className="flex items-center gap-1 sm:gap-2">
            <Link
              href="/login"
              className="inline-flex h-9 items-center rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Log in
            </Link>
            <Link
              href="/signup"
              className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              Sign up
            </Link>
          </div>
        </nav>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-b from-indigo-50/60 via-background to-background dark:from-indigo-950/20"
        />
        <div className="container flex flex-col items-center gap-6 py-20 text-center sm:py-28">
          <div className="inline-flex items-center gap-2 rounded-full border bg-background/80 px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Auto-posting that doesn&apos;t sound like a robot
          </div>

          <h1 className="max-w-3xl text-balance text-4xl font-bold tracking-tight sm:text-6xl">
            Your social calendar,{" "}
            <span className="bg-gradient-to-r from-indigo-600 to-violet-600 bg-clip-text text-transparent">
              planned and posted
            </span>{" "}
            on autopilot.
          </h1>

          <p className="max-w-xl text-pretty text-base text-muted-foreground sm:text-lg">
            marketingmagic writes on-brand posts, schedules them across every channel, and
            learns what works — so your marketing runs itself while you stay in control.
          </p>

          <div className="flex w-full flex-col items-center gap-3 sm:w-auto sm:flex-row">
            <Link
              href="/start"
              className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 sm:w-auto"
            >
              See a preview plan — 30s, no signup
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
            <Link
              href="/signup"
              className="inline-flex h-11 w-full items-center justify-center rounded-md border border-input px-6 text-sm font-medium transition-colors hover:bg-accent sm:w-auto"
            >
              Sign up free
            </Link>
          </div>

          <p className="text-xs text-muted-foreground">No credit card required.</p>

          {/* Channels */}
          <div className="mt-6 flex flex-col items-center gap-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Publishes to
            </p>
            <ul className="flex max-w-2xl flex-wrap items-center justify-center gap-x-2 gap-y-2">
              {CHANNELS.map((c) => (
                <li
                  key={c}
                  className="rounded-full border bg-background px-3 py-1 text-xs font-medium text-muted-foreground"
                >
                  {c}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="border-t bg-muted/20">
        <div className="container py-16 sm:py-20">
          <div className="mx-auto max-w-2xl text-center">
            <p className="label-eyebrow">Why marketingmagic</p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
              Less posting busywork. More of what works.
            </h2>
          </div>
          <div className="mt-10 grid gap-5 sm:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, body }) => (
              <div
                key={title}
                className="rounded-xl border bg-card p-6 text-left transition-shadow duration-200 hover:shadow-sm"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-600/10 text-indigo-600 dark:text-indigo-400">
                  <Icon className="h-5 w-5" aria-hidden />
                </span>
                <h3 className="mt-4 font-semibold">{title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Video callout */}
      <section className="border-t">
        <div className="container py-16 sm:py-20">
          <div className="flex flex-col items-center gap-6 rounded-2xl border bg-gradient-to-br from-indigo-600 to-violet-600 px-6 py-12 text-center text-white sm:px-12">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/15">
              <Clapperboard className="h-6 w-6" aria-hidden />
            </span>
            <h2 className="max-w-xl text-2xl font-semibold tracking-tight sm:text-3xl">
              Now with AI short-form video
            </h2>
            <p className="max-w-lg text-pretty text-sm text-white/85 sm:text-base">
              Turn a topic into a captioned short with your own keys, then publish it
              everywhere — same approve-and-go flow as your posts.
            </p>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="border-t bg-muted/20">
        <div className="container py-16 sm:py-20">
          <div className="mx-auto max-w-2xl text-center">
            <p className="label-eyebrow">How it works</p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
              Set up once. Stay in front of your audience.
            </h2>
          </div>
          <ol className="mx-auto mt-10 grid max-w-4xl gap-5 sm:grid-cols-3">
            {STEPS.map(({ n, title, body }) => (
              <li key={n} className="rounded-xl border bg-card p-6">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
                  {n}
                </span>
                <h3 className="mt-4 font-semibold">{title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Final CTA */}
      <section className="border-t">
        <div className="container flex flex-col items-center gap-6 py-20 text-center">
          <h2 className="max-w-2xl text-3xl font-bold tracking-tight sm:text-4xl">
            Put your marketing on autopilot today.
          </h2>
          <div className="flex w-full flex-col items-center gap-3 sm:w-auto sm:flex-row">
            <Link
              href="/start"
              className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 sm:w-auto"
            >
              See a preview plan
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
            <Link
              href="/signup"
              className="inline-flex h-11 w-full items-center justify-center rounded-md border border-input px-6 text-sm font-medium transition-colors hover:bg-accent sm:w-auto"
            >
              Sign up free
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t">
        <div className="container flex flex-col items-center justify-between gap-4 py-8 text-sm text-muted-foreground sm:flex-row">
          <div className="flex items-center gap-2 font-medium text-foreground">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-indigo-600 to-violet-600 text-white">
              <Sparkles className="h-3.5 w-3.5" aria-hidden />
            </span>
            marketingmagic
          </div>
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
