import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight, Clock } from "lucide-react";
import { ToolShell, SignupCta } from "./shell";
import { TOOL_PLATFORMS, topSlots } from "./platforms";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Best Time to Post on Social Media (2026 Data) · marketingmagic",
  description:
    "Free, data-backed best-times-to-post for Instagram, LinkedIn, X, YouTube, Threads, Facebook and Bluesky. Built from millions of posts across published industry studies — no signup.",
  alternates: { canonical: "/tools/best-time-to-post" },
  robots: { index: true, follow: true },
  openGraph: {
    title: "Best Time to Post on Social Media (2026 Data)",
    description:
      "Data-backed peak posting windows for every major platform. Free, no signup.",
    type: "website",
  },
};

export default function BestTimeIndexPage() {
  return (
    <ToolShell>
      {/* ─── Header ──────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden border-b">
        <div aria-hidden className="brand-glow pointer-events-none absolute inset-x-0 top-0 -z-10 h-[320px]" />
        <div className="container flex flex-col items-center gap-5 py-16 text-center sm:py-20">
          <div className="badge-glow inline-flex items-center gap-2 rounded-full border bg-background/80 px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur">
            <Clock className="h-3.5 w-3.5" style={{ color: "hsl(var(--brand-grad-start))" }} aria-hidden />
            Free tool · no signup
          </div>
          <h1 className="max-w-3xl text-balance text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
            The best time to post on <span className="brand-gradient-text">social media</span>
          </h1>
          <p className="max-w-xl text-pretty text-base text-muted-foreground sm:text-lg">
            Peak posting windows for every major platform, drawn from published industry studies
            covering millions of posts — the same engagement model that powers marketingmagic&apos;s
            smart scheduling. Pick a platform to see its heatmap.
          </p>
        </div>
      </section>

      {/* ─── Platform grid ───────────────────────────────────────────────── */}
      <section className="container py-14">
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {TOOL_PLATFORMS.map((p) => {
            const best = topSlots(p.slug, 1)[0];
            return (
              <Link
                key={p.slug}
                href={`/tools/best-time-to-post/${p.slug}`}
                className="card-hover group flex flex-col rounded-2xl border bg-card p-6 transition-transform hover:-translate-y-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-lg font-semibold">{p.label}</h2>
                  <ArrowRight
                    className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                    aria-hidden
                  />
                </div>
                {best ? (
                  <p className="mt-2 text-sm font-medium" style={{ color: "hsl(var(--positive))" }}>
                    Peak: {best.dayLabelLong}, {best.timeLabel}
                  </p>
                ) : null}
                <p className="mt-2 text-sm text-muted-foreground">{p.blurb}</p>
                <span className="mt-4 text-xs font-medium text-muted-foreground group-hover:text-foreground">
                  See the {p.label} heatmap →
                </span>
              </Link>
            );
          })}
        </div>
      </section>

      {/* ─── CTA ─────────────────────────────────────────────────────────── */}
      <section className="container pb-20">
        <SignupCta
          headline="Generic best-times are a starting point. Your audience is the answer."
          body="marketingmagic learns when YOUR followers actually engage and schedules every post into your real peak windows — across all 8 channels, from one queue."
        />
      </section>
    </ToolShell>
  );
}
