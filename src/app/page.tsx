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
import { SiteNav } from "@/components/site-nav";
import { ExplainerVideo } from "@/components/explainer-video";
import { TIERS, aiCreditsLabel, type PlanId } from "@/lib/billing/tiers";

// Deterministic sparkle field for the hero. Positions/sizes/timing are fixed
// (no Math.random) so SSR and client markup match — no hydration mismatch and
// no layout shift. Each star reads its placement from CSS custom props that the
// .sparkle rule animates (see globals.css). Spread across the hero box; a few
// large four-point glints, many small twinkles.
const SPARKLES = [
  { x: "8%", y: "22%", s: "14px", d: "0s", t: "4.5s" },
  { x: "18%", y: "62%", s: "8px", d: "1.2s", t: "5s" },
  { x: "27%", y: "12%", s: "6px", d: "2.1s", t: "4s" },
  { x: "33%", y: "78%", s: "10px", d: "0.6s", t: "5.5s" },
  { x: "44%", y: "30%", s: "5px", d: "1.8s", t: "3.6s" },
  { x: "52%", y: "8%", s: "12px", d: "2.6s", t: "6s" },
  { x: "61%", y: "70%", s: "7px", d: "0.3s", t: "4.2s" },
  { x: "69%", y: "20%", s: "9px", d: "1.5s", t: "5.2s" },
  { x: "76%", y: "55%", s: "6px", d: "2.9s", t: "3.8s" },
  { x: "84%", y: "14%", s: "13px", d: "0.9s", t: "5.8s" },
  { x: "90%", y: "44%", s: "8px", d: "2.2s", t: "4.6s" },
  { x: "94%", y: "72%", s: "5px", d: "1.1s", t: "4s" },
  { x: "13%", y: "40%", s: "6px", d: "3.1s", t: "5s" },
  { x: "40%", y: "58%", s: "7px", d: "1.7s", t: "4.4s" },
  { x: "57%", y: "38%", s: "5px", d: "2.4s", t: "3.9s" },
  { x: "72%", y: "82%", s: "10px", d: "0.4s", t: "6.2s" },
] as const;

export const metadata = {
  title: "marketingmagic — build in public without becoming a full-time poster",
  description:
    "You're shipping product, not posting. marketingmagic turns your build into consistent, on-brand content and AI short-form video across X and every channel, learns what actually lands, and runs itself. You just approve.",
};

// Hero proof-strip stats. Illustrative product framing, not customer metrics.
const HERO_STATS = [
  { value: "8", label: "channels, one queue" },
  { value: "0", label: "posts you didn't approve" },
  { value: "∞", label: "themes it keeps testing" },
] as const;

// The three pillars — ordered by the strategic wedge: learning loop FIRST.
const PILLARS = [
  {
    icon: TrendingUp,
    eyebrow: "The difference",
    title: "It learns what works",
    body: "Every post is measured. A Bayesian model finds which of your build-in-public threads — shipping updates, lessons, wins — actually move engagement, and quietly retires the ones that don't. Your feed gets smarter every week.",
  },
  {
    icon: Clapperboard,
    eyebrow: "Built in",
    title: "AI short-form video",
    body: "Turn a feature you just shipped into a captioned short — bring your own keys — then publish it everywhere through the same approve-and-go flow as your posts. No separate tool, no export dance.",
  },
  {
    icon: ShieldCheck,
    eyebrow: "On your terms",
    title: "Posts itself, on your terms",
    body: "Approve in one tap between commits, or let the threads you trust post on their own once they've proven out. Automatic when you're heads-down building, never when you don't want it.",
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
    title: "Point it at your product",
    body: "Paste your site or write a one-line brief. It learns your voice, who you're building for, and what you ship.",
  },
  {
    icon: CalendarRange,
    n: "02",
    title: "Get a full week, drafted",
    body: "A complete, on-voice build-in-public calendar — leading on X, ready for every channel. Drafted for you, not generic filler.",
  },
  {
    icon: Repeat,
    n: "03",
    title: "Approve, then go build",
    body: "Skim what you like; let the rest publish while you ship. The loop measures results and reshapes next week's plan.",
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
  "YouTube",
] as const;

// Aggregate stat band — CAPABILITY framing, not fabricated customer counts (no
// real customers yet, so no "10,000 users"). Each is a true property of the
// product. Tune the copy, not into a false metric.
const SOCIAL_STATS = [
  { value: "8", label: "channels, one queue" },
  { value: "∞", label: "AI writing on paid plans" },
  { value: "1-tap", label: "approve or auto-post" },
  { value: "30s", label: "to a preview plan" },
] as const;

// Illustrative social proof. There are no real customers yet, so these are
// CLEARLY illustrative (generic roles, no fabricated names/companies/logos) and
// the section carries an "early access" note. Replace `quote` blocks with real,
// attributed testimonials as they come in; structure is ready for them.
const PROOF = [
  {
    quote:
      "I was shipping daily and posting never. Now my build shows up on X without me stopping to write — and I can see which updates actually land.",
    name: "Solo founder",
    role: "Building in public",
  },
  {
    quote:
      "The approval flow is the whole thing. I trust it with the threads that have proven out, and I still gate everything else between commits.",
    name: "Indie hacker",
    role: "Early-stage SaaS",
  },
  {
    quote:
      "Turning a feature I just shipped into a short-form video — in the same place I plan posts — saved me an entire tool and a freelancer.",
    name: "Technical founder",
    role: "Bootstrapped product",
  },
  {
    quote:
      "I went from a blank feed every Monday to a full week of build-in-public posts drafted in my voice. I skim and approve over coffee.",
    name: "Maker",
    role: "Shipping a side project",
  },
  {
    quote:
      "One handle, one queue, eight platforms — X first. The format adapts per channel so I'm not rewriting the same shipping update five times.",
    name: "Founder",
    role: "Developer tool",
  },
  {
    quote:
      "The weekly 'what we learned and changed' digest is the part I didn't know I needed. It's like having a growth person while I'm heads-down on the product.",
    name: "Indie maker",
    role: "Bootstrapped SaaS",
  },
] as const;

// Pricing teaser ladder (Free → Agency). The full breakdown lives on /pricing;
// this is the at-a-glance row that answers "what does it cost?" before the
// final CTA. "Creator" (founder) is the highlighted middle tier.
const PRICING_ORDER: PlanId[] = ["hobby", "pro", "founder", "agency"];
const PRICING_HIGHLIGHT: PlanId = "founder";

// Objection-handling FAQ. Native <details> accordion — accessible + zero JS.
const FAQS = [
  {
    q: "How is this different from a scheduler like Buffer or Hootsuite?",
    a: "Schedulers post and forget — and they still expect you to write everything. marketingmagic turns your build into the posts for you, measures each one, ranks the threads that actually earn engagement, and feeds the winners back into next week's plan. It gets smarter on its own while you stay heads-down on the product.",
  },
  {
    q: "Will it post without my approval?",
    a: "Only if you let it. Everything is approve-and-go by default. You can opt specific themes into auto-posting once they've proven out — and turn that off any time. Automatic when you want it, never when you don't.",
  },
  {
    q: "Which channels are supported?",
    a: "X, LinkedIn, Instagram, Threads, Facebook, Bluesky, TikTok, and YouTube — all from one queue. Connect the ones you use; the plan adapts to each channel's format.",
  },
  {
    q: "Do I need my own AI keys for video?",
    a: "Short-form video uses a bring-your-own-key model, so there's no surprise metering on our side — you control the spend. AI writing and images are included in your plan.",
  },
  {
    q: "Can I try it before paying?",
    a: "Yes. The Free plan is free forever (one channel, ten posts a month), and you can preview a full week of on-brand content in about 30 seconds with no signup at all.",
  },
] as const;

export default function HomePage() {
  return (
    <main className="flex min-h-dvh flex-col">
      {/* ─── Nav ─────────────────────────────────────────────────────────── */}
      <SiteNav />

      {/* ─── Hero ────────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden">
        <div aria-hidden className="brand-glow pointer-events-none absolute inset-x-0 top-0 -z-10 h-[480px]" />
        {/* Aurora blobs — slow drifting colour behind the hero. */}
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
          <span className="aurora aurora-a left-[8%] top-[-6rem] h-72 w-72" />
          <span className="aurora aurora-b right-[4%] top-[2rem] h-80 w-80" />
          <span className="aurora aurora-c left-1/2 top-[10rem] h-64 w-64 -translate-x-1/2" />
        </div>
        {/* Twinkling sparkle field. Decorative, deterministic, reduced-motion safe. */}
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
          {SPARKLES.map((sp, i) => (
            <span
              key={i}
              className="sparkle"
              style={
                {
                  "--x": sp.x,
                  "--y": sp.y,
                  "--s": sp.s,
                  "--d": sp.d,
                  "--t": sp.t,
                } as React.CSSProperties
              }
            />
          ))}
        </div>
        <div className="container grid items-center gap-12 py-20 sm:py-28 lg:grid-cols-[1.05fr_0.95fr] lg:gap-10">
          {/* Left: copy + CTAs + proof. Centered on mobile, left-aligned at lg. */}
          <div className="flex flex-col items-center gap-7 text-center lg:items-start lg:text-left">
            <div className="badge-glow inline-flex items-center gap-2 rounded-full border bg-background/80 px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur">
              <Sparkles className="h-3.5 w-3.5" style={{ color: "hsl(var(--brand-grad-start))" }} aria-hidden />
              Build in public, without becoming a full-time poster
            </div>

            <h1 className="max-w-4xl text-balance text-4xl font-bold leading-[1.05] tracking-tight sm:text-6xl">
              You're shipping product,{" "}
              <span className="brand-gradient-text">not posting.</span> So let it post.
            </h1>

            <p className="max-w-xl text-pretty text-base text-muted-foreground sm:text-lg">
              marketingmagic turns your build into consistent, on-brand posts and AI short-form
              video — on X and every channel — learns what actually lands, and runs itself. You just
              approve between commits.
            </p>

            <div className="flex w-full flex-col items-center gap-3 sm:w-auto sm:flex-row">
              <Link
                href="/start"
                className="btn-magic inline-flex h-12 w-full items-center justify-center gap-2 rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:opacity-95 hover:shadow-xl hover:shadow-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:w-auto"
              >
                See a preview plan — 30s, no signup
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
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
                <div key={s.label} className="flex flex-col items-center gap-1 lg:items-start">
                  <dt className="sr-only">{s.label}</dt>
                  <dd className="text-3xl font-bold tabular-nums brand-gradient-text">{s.value}</dd>
                  <p className="text-xs text-muted-foreground">{s.label}</p>
                </div>
              ))}
            </dl>
          </div>

          {/* Right: floating product mock — "this week's plan", the loop made
              tangible in the hero. Decorative; the real proof board is below. */}
          <HeroMock />
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
          <div className="reveal space-y-5">
            <p className="label-eyebrow">Why it&apos;s different</p>
            <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
              Your audience, growing while you build.
            </h2>
            <p className="text-pretty text-muted-foreground">
              Schedulers post and forget. marketingmagic treats every post as a signal. A
              Bayesian model ranks your build-in-public threads by the engagement they actually
              earn, flags the confident winners, and feeds them straight back into next
              week&apos;s plan — so your limited time goes to what&apos;s proven, not what you hope.
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
          <div className="reveal rounded-2xl border bg-card p-6 shadow-sm sm:p-8">
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
          <div className="reveal mx-auto max-w-2xl text-center">
            <p className="label-eyebrow">What you get</p>
            <h2 className="mt-2 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
              Ship the product. It handles the posting.
            </h2>
          </div>
          <div className="mt-12 grid gap-5 lg:grid-cols-3">
            {PILLARS.map(({ icon: Icon, eyebrow, title, body }) => (
              <div
                key={title}
                className="reveal spotlight-card card-hover group rounded-2xl border bg-card p-7 text-left transition-transform hover:-translate-y-1"
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
          <div className="reveal brand-gradient relative flex flex-col items-center gap-6 overflow-hidden rounded-3xl border px-6 py-14 text-center text-white sm:px-12">
            {/* Cinematic background loop (generated with FAL/Kling, on-brand
                indigo→violet light ribbons). Muted + looping + playsInline so it
                autoplays everywhere without sound. The brand-gradient on the panel
                is the base layer + instant fallback (and the poster), so there's
                no black flash before the video decodes and no CLS. Hidden under
                prefers-reduced-motion → those users keep the static gradient. */}
            <video
              aria-hidden
              className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-60 mix-blend-screen motion-reduce:hidden"
              autoPlay
              muted
              loop
              playsInline
              preload="metadata"
              poster="/explainer-seed.jpg"
            >
              <source src="/explainer-loop.mp4" type="video/mp4" />
            </video>
            {/* Scrim: keep the white headline/body legible over the moving video
                (contrast can't rely on a single frame). */}
            <div aria-hidden className="pointer-events-none absolute inset-0 bg-black/25" />
            <span
              aria-hidden
              className="pointer-events-none absolute -right-10 -top-10 h-48 w-48 rounded-full bg-white/10 blur-2xl"
            />
            <span
              aria-hidden
              className="pointer-events-none absolute -bottom-12 -left-8 h-56 w-56 rounded-full bg-white/10 blur-2xl"
            />
            {/* A few white sparkles dusted over the gradient panel. */}
            <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
              {[
                { x: "12%", y: "24%", s: "10px", d: "0s", t: "4.5s" },
                { x: "82%", y: "30%", s: "8px", d: "1.4s", t: "5s" },
                { x: "68%", y: "72%", s: "12px", d: "0.7s", t: "5.6s" },
                { x: "28%", y: "78%", s: "7px", d: "2.2s", t: "4.2s" },
              ].map((sp, i) => (
                <span
                  key={i}
                  className="sparkle"
                  style={
                    {
                      "--x": sp.x,
                      "--y": sp.y,
                      "--s": sp.s,
                      "--d": sp.d,
                      "--t": sp.t,
                      background:
                        "radial-gradient(circle, white 0%, rgba(255,255,255,0.6) 40%, transparent 70%)",
                    } as React.CSSProperties
                  }
                />
              ))}
            </div>
            <span className="relative z-10 flex h-12 w-12 items-center justify-center rounded-2xl bg-white/15 backdrop-blur">
              <Clapperboard className="h-6 w-6" aria-hidden />
            </span>
            <h2 className="relative z-10 max-w-xl text-balance text-2xl font-semibold tracking-tight sm:text-3xl">
              Short-form video, generated and published in the same place.
            </h2>
            <p className="relative z-10 max-w-lg text-pretty text-sm text-white/90 sm:text-base">
              Turn a feature you just shipped into a captioned short with your own keys — then send
              it to X and every channel through the same approve-and-go flow as your posts.
            </p>
            <Link
              href="/signup"
              className="relative z-10 inline-flex h-11 items-center justify-center gap-2 rounded-md bg-white px-6 text-sm font-medium text-foreground transition-transform hover:scale-[1.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
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
              Set it up once. Then just keep shipping.
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

      {/* ─── See how it works (explainer video) ──────────────────────────── */}
      <section className="border-b">
        <div className="container py-20 sm:py-28">
          <div className="reveal mx-auto max-w-2xl text-center">
            <p className="label-eyebrow">See it in action</p>
            <h2 className="mt-2 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
              Watch a week of build-in-public posts write themselves.
            </h2>
            <p className="mt-3 text-pretty text-muted-foreground">
              A short walkthrough: point it at your product, get a full week drafted, approve what
              you like — and watch the loop double down on what your audience actually wants.
            </p>
          </div>
          <div className="reveal mt-12">
            {/* No video source yet → renders a branded "coming soon" poster.
                Drop an mp4 in /public and pass src="/explainer.mp4" (or an
                embedUrl), plus a poster, when the clip is ready — nothing else
                changes. */}
            <ExplainerVideo title="How marketingmagic works" />
          </div>
        </div>
      </section>

      {/* ─── Social proof: stats + trust strip + testimonials ────────────── */}
      <section className="border-b">
        <div className="container py-20 sm:py-28">
          <div className="mx-auto max-w-2xl text-center">
            <p className="label-eyebrow">Why founders pick it</p>
            <h2 className="mt-2 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
              Built for founders who&apos;d rather ship than post.
            </h2>
          </div>

          {/* Aggregate stat band — product-truthful framing (capabilities, not
              fabricated customer counts). */}
          <dl className="reveal mx-auto mt-12 grid max-w-4xl grid-cols-2 gap-6 rounded-2xl border bg-card p-8 sm:grid-cols-4">
            {SOCIAL_STATS.map((s) => (
              <div key={s.label} className="text-center">
                <dt className="sr-only">{s.label}</dt>
                <dd className="text-3xl font-bold tabular-nums brand-gradient-text">{s.value}</dd>
                <p className="mt-1 text-xs text-muted-foreground">{s.label}</p>
              </div>
            ))}
          </dl>

          {/* Trust strip — the channels it works with. Honest "works with", not
              "trusted by". */}
          <div className="reveal mt-10 text-center">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Plans and publishes to
            </p>
            <ul className="mt-4 flex flex-wrap items-center justify-center gap-2.5">
              {CHANNELS.map((c) => (
                <li
                  key={c}
                  className="rounded-full border bg-background px-3.5 py-1.5 text-sm font-medium text-foreground/80"
                >
                  {c}
                </li>
              ))}
            </ul>
          </div>

          {/* Testimonials. Illustrative until real ones land (see PROOF note). */}
          <div className="mt-14 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
            {PROOF.map((p) => (
              <figure key={p.name + p.role} className="reveal flex flex-col rounded-2xl border bg-card p-7">
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

          {/* Honest pre-launch note — we don't fake "10,000 users". */}
          <p className="mx-auto mt-8 max-w-xl text-center text-xs text-muted-foreground">
            Early access — these reflect the workflows marketingmagic is built for. Real customer
            stories land here as they come in.
          </p>
        </div>
      </section>

      {/* ─── Pricing teaser ──────────────────────────────────────────────── */}
      <section className="border-b bg-muted/20">
        <div className="container py-20 sm:py-28">
          <div className="reveal mx-auto max-w-2xl text-center">
            <p className="label-eyebrow">Pricing</p>
            <h2 className="mt-2 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
              Start free. Upgrade when it&apos;s working.
            </h2>
            <p className="mt-3 text-pretty text-muted-foreground">
              Unlimited AI writing on every paid plan, plus AI images and short-form video. One
              subscription covers all your workspaces.
            </p>
          </div>

          <div className="reveal mx-auto mt-12 grid max-w-5xl gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {PRICING_ORDER.map((id) => {
              const tier = TIERS[id];
              const highlighted = id === PRICING_HIGHLIGHT;
              const credits = aiCreditsLabel(id);
              return (
                <div
                  key={id}
                  className={
                    "relative flex flex-col rounded-2xl border bg-card p-6 " +
                    (highlighted ? "gradient-border shadow-lg" : "")
                  }
                >
                  {highlighted ? (
                    <span className="brand-gradient absolute -top-3 left-1/2 -translate-x-1/2 rounded-full px-3 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                      Most popular
                    </span>
                  ) : null}
                  <h3 className="text-sm font-semibold">{tier.name}</h3>
                  <div className="mt-1 flex items-baseline gap-1">
                    <span className="text-2xl font-bold tabular-nums">${tier.priceMonthly}</span>
                    <span className="text-xs text-muted-foreground">/mo</span>
                  </div>
                  <p className="mt-3 text-xs text-muted-foreground">
                    {tier.limits.channels === -1
                      ? "Unlimited channels"
                      : `${tier.limits.channels} channel${tier.limits.channels === 1 ? "" : "s"}`}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {tier.limits.postsPerMonth === -1 ? "Unlimited AI writing" : `${tier.limits.postsPerMonth} posts / mo`}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {credits === "0" ? "No AI media" : `${credits} AI credits / mo`}
                  </p>
                </div>
              );
            })}
          </div>

          <div className="reveal mt-8 flex justify-center">
            <Link
              href="/pricing"
              className="inline-flex h-11 items-center justify-center gap-2 rounded-md border border-input px-6 text-sm font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              Compare all plans
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </div>
        </div>
      </section>

      {/* ─── FAQ ─────────────────────────────────────────────────────────── */}
      <section className="border-b">
        <div className="container py-20 sm:py-28">
          <div className="mx-auto max-w-2xl text-center">
            <p className="label-eyebrow">Questions</p>
            <h2 className="mt-2 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
              Everything you might be wondering.
            </h2>
          </div>
          <div className="mx-auto mt-12 max-w-3xl divide-y rounded-2xl border bg-card">
            {FAQS.map((f) => (
              <details key={f.q} className="group px-6 [&_summary::-webkit-details-marker]:hidden">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5 text-left text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                  {f.q}
                  <ArrowRight
                    className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-90"
                    aria-hidden
                  />
                </summary>
                <p className="pb-5 text-sm leading-relaxed text-muted-foreground">{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ─── Founder note / credibility ──────────────────────────────────── */}
      <section className="border-b bg-muted/20">
        <div className="reveal container max-w-3xl py-20 text-center sm:py-24">
          <span className="brand-gradient mx-auto flex h-12 w-12 items-center justify-center rounded-2xl text-white">
            <Sparkles className="h-6 w-6" aria-hidden />
          </span>
          <h2 className="mt-5 text-balance text-2xl font-semibold tracking-tight sm:text-3xl">
            Why we built this
          </h2>
          <p className="mt-4 text-pretty text-base leading-relaxed text-muted-foreground">
            We&apos;re builders too. We kept shipping product and never posting — the marketing was
            always the thing that slipped. Most social tools don&apos;t help: they hand you a blank
            scheduler and walk away. marketingmagic is the loop we wanted: it drafts your build in
            your voice, leads on X and ships across all eight channels, measures what each post
            actually earns, and pours your scarce time into what proves out. You stay in control of
            every post; it just keeps you visible while you build.
          </p>
          <p className="mt-6 text-sm font-medium">— The marketingmagic team</p>
        </div>
      </section>

      {/* ─── Final CTA ───────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden">
        <div aria-hidden className="brand-glow pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-[420px] rotate-180" />
        {/* Aurora + sparkle echo of the hero, mirrored to the bottom. */}
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
          <span className="aurora aurora-b left-[10%] bottom-[-4rem] h-72 w-72" />
          <span className="aurora aurora-a right-[8%] bottom-[1rem] h-80 w-80" />
          {[
            { x: "15%", y: "30%", s: "10px", d: "0.5s", t: "5s" },
            { x: "78%", y: "24%", s: "12px", d: "1.6s", t: "5.8s" },
            { x: "60%", y: "68%", s: "7px", d: "2.4s", t: "4.2s" },
            { x: "34%", y: "72%", s: "8px", d: "0.9s", t: "4.8s" },
          ].map((sp, i) => (
            <span
              key={i}
              className="sparkle"
              style={
                {
                  "--x": sp.x,
                  "--y": sp.y,
                  "--s": sp.s,
                  "--d": sp.d,
                  "--t": sp.t,
                } as React.CSSProperties
              }
            />
          ))}
        </div>
        <div className="reveal container flex flex-col items-center gap-6 py-24 text-center">
          <h2 className="max-w-2xl text-balance text-3xl font-bold tracking-tight sm:text-5xl">
            Keep building. Let your audience{" "}
            <span className="brand-gradient-text">grow on autopilot.</span>
          </h2>
          <p className="max-w-md text-pretty text-muted-foreground">
            See what a week of build-in-public content looks like for your product — leading on X.
            No signup, 30 seconds.
          </p>
          <div className="flex w-full flex-col items-center gap-3 sm:w-auto sm:flex-row">
            <Link
              href="/start"
              className="btn-magic inline-flex h-12 w-full items-center justify-center gap-2 rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:opacity-95 hover:shadow-xl hover:shadow-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:w-auto"
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
            <Link href="/tools" className="transition-colors hover:text-foreground">
              Free tools
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

// Hero product mock — a floating "this week's plan" card. Decorative (aria-hidden):
// it's a stylised preview of the approval queue, not real data. The float-card +
// gradient-border classes give it the bob + glowing edge; reduced-motion holds it
// still. Sits on the right of the hero at lg, stacks under the copy on mobile.
const MOCK_QUEUE = [
  { channel: "LinkedIn", theme: "Behind-the-scenes", time: "Tue · 9:00", tone: "leading" },
  { channel: "X", theme: "Customer win", time: "Tue · 1:30", tone: "ok" },
  { channel: "Instagram", theme: "Short-form video", time: "Wed · 11:00", tone: "video" },
] as const;

function HeroMock() {
  return (
    <div aria-hidden className="relative mx-auto w-full max-w-md lg:mx-0">
      {/* Soft brand halo behind the card. */}
      <div className="pointer-events-none absolute -inset-6 -z-10 rounded-[2rem] bg-[radial-gradient(60%_60%_at_50%_30%,hsl(var(--brand-grad-start)/0.22),transparent_70%)] blur-xl" />

      <div className="float-card gradient-border rounded-2xl border bg-card/90 p-5 shadow-2xl shadow-primary/10 backdrop-blur">
        {/* Window chrome */}
        <div className="mb-4 flex items-center gap-2">
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-foreground/15" />
            <span className="h-2.5 w-2.5 rounded-full bg-foreground/15" />
            <span className="h-2.5 w-2.5 rounded-full bg-foreground/15" />
          </span>
          <span className="ml-1 text-xs font-medium text-muted-foreground">This week&apos;s plan</span>
          <span className="brand-gradient ml-auto rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
            Auto-tuned
          </span>
        </div>

        {/* Queue rows */}
        <ul className="space-y-2.5">
          {MOCK_QUEUE.map((row) => (
            <li
              key={row.channel}
              className="flex items-center gap-3 rounded-xl border bg-background/60 p-3"
            >
              <span
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-xs font-bold"
                style={{
                  backgroundColor: "hsl(var(--brand-grad-start) / 0.1)",
                  color: "hsl(var(--brand-grad-start))",
                }}
              >
                {row.channel.slice(0, 2)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  {row.theme}
                  {row.tone === "leading" ? (
                    <span className="brand-gradient rounded-full px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-white">
                      Leading
                    </span>
                  ) : null}
                  {row.tone === "video" ? (
                    <Clapperboard className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                  ) : null}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {row.channel} · {row.time}
                </span>
              </span>
              <CheckCircle2
                className="h-5 w-5 shrink-0"
                style={{ color: "hsl(var(--positive))" }}
                aria-hidden
              />
            </li>
          ))}
        </ul>

        {/* Footer stat */}
        <div className="mt-4 flex items-center justify-between rounded-xl bg-muted/40 px-3 py-2.5">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <TrendingUp className="h-3.5 w-3.5" style={{ color: "hsl(var(--brand-grad-start))" }} aria-hidden />
            Engagement vs last week
          </span>
          <span className="text-sm font-semibold tabular-nums" style={{ color: "hsl(var(--positive))" }}>
            +27%
          </span>
        </div>
      </div>

      {/* Floating accent chip, lower-left, breaking the card edge for depth. */}
      <div className="absolute -bottom-4 -left-4 hidden items-center gap-2 rounded-xl border bg-card px-3 py-2 shadow-lg sm:flex">
        <Trophy className="h-4 w-4" style={{ color: "hsl(var(--brand-grad-start))" }} aria-hidden />
        <span className="text-xs font-medium">3 themes winning</span>
      </div>
    </div>
  );
}
