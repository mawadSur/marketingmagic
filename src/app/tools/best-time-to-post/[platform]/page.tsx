import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArrowLeft, TrendingUp } from "lucide-react";
import { ToolShell, SignupCta } from "../shell";
import { BestWindowsHeatmap } from "../heatmap";
import {
  TOOL_PLATFORMS,
  getToolPlatform,
  platformGrid,
  topSlots,
  maxRate,
  sourceFor,
} from "../platforms";

export const dynamic = "force-static";
export const dynamicParams = false;

// Pre-render one static page per platform at build time. Drives the per-route
// SEO surface (each platform gets its own indexable URL + metadata).
export function generateStaticParams() {
  return TOOL_PLATFORMS.map((p) => ({ platform: p.slug }));
}

interface PageProps {
  params: Promise<{ platform: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { platform: slug } = await params;
  const platform = getToolPlatform(slug);
  if (!platform) return {};
  const canonical = `/tools/best-time-to-post/${slug}`;
  const title = `Best Time to Post on ${platform.label} (2026 Data) · marketingmagic`;
  const description = `When is the best time to post on ${platform.label}? See the data-backed peak posting windows and a full weekly engagement heatmap. Free, no signup.`;
  return {
    title,
    description,
    alternates: { canonical },
    robots: { index: true, follow: true },
    openGraph: { title, description, type: "article" },
  };
}

export default async function PlatformPage({ params }: PageProps) {
  const { platform: slug } = await params;
  const platform = getToolPlatform(slug);
  if (!platform) notFound();

  const grid = platformGrid(slug);
  const top = topSlots(slug, 5);
  const max = maxRate(slug);
  const source = sourceFor(slug);
  const topKeys = new Set(top.map((t) => `${t.dayOfWeek}-${t.hourBucket}`));
  const best = top[0];

  return (
    <ToolShell>
      {/* ─── Header ──────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden border-b">
        <div aria-hidden className="brand-glow pointer-events-none absolute inset-x-0 top-0 -z-10 h-[280px]" />
        <div className="container flex flex-col items-center gap-4 py-14 text-center sm:py-16">
          <Link
            href="/tools/best-time-to-post"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            All platforms
          </Link>
          <h1 className="max-w-3xl text-balance text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
            Best time to post on <span className="brand-gradient-text">{platform.label}</span>
          </h1>
          {best ? (
            <p className="max-w-xl text-pretty text-base text-muted-foreground sm:text-lg">
              The single strongest window is{" "}
              <span className="font-semibold text-foreground">
                {best.dayLabelLong}, {best.timeLabel}
              </span>
              . {platform.blurb}
            </p>
          ) : (
            <p className="max-w-xl text-pretty text-base text-muted-foreground sm:text-lg">
              {platform.blurb}
            </p>
          )}
        </div>
      </section>

      <section className="container grid max-w-5xl gap-12 py-14 lg:grid-cols-[1.4fr_1fr]">
        {/* ─── Heatmap ───────────────────────────────────────────────────── */}
        <div className="space-y-4">
          <div>
            <p className="label-eyebrow">Weekly engagement heatmap</p>
            <h2 className="text-xl font-semibold tracking-tight">
              When {platform.label} engagement peaks
            </h2>
          </div>
          <div className="rounded-2xl border bg-card p-5 shadow-sm sm:p-6">
            <BestWindowsHeatmap
              grid={grid}
              maxRate={max}
              topKeys={topKeys}
              label={`Weekly posting-engagement heatmap for ${platform.label}, by day of week and 2-hour window`}
            />
          </div>
        </div>

        {/* ─── Top windows ───────────────────────────────────────────────── */}
        <div className="space-y-4">
          <div>
            <p className="label-eyebrow">Top windows</p>
            <h2 className="text-xl font-semibold tracking-tight">The 5 best slots</h2>
          </div>
          <ol className="space-y-2.5">
            {top.map((slot, i) => (
              <li
                key={`${slot.dayOfWeek}-${slot.hourBucket}`}
                className="flex items-center gap-3 rounded-xl border bg-card p-3.5"
              >
                <span
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm font-bold tabular-nums"
                  style={{
                    backgroundColor: "hsl(var(--brand-grad-start) / 0.1)",
                    color: "hsl(var(--brand-grad-start))",
                  }}
                >
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{slot.dayLabelLong}</span>
                  <span className="block text-xs text-muted-foreground tabular-nums">
                    {slot.timeLabel}
                  </span>
                </span>
                {i === 0 ? (
                  <span className="flex items-center gap-1 text-xs font-medium" style={{ color: "hsl(var(--positive))" }}>
                    <TrendingUp className="h-3.5 w-3.5" aria-hidden />
                    Peak
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ─── Data-grounded explanation ───────────────────────────────────── */}
      <section className="container max-w-3xl pb-14">
        <div className="rounded-2xl border bg-muted/20 p-7">
          <p className="label-eyebrow">How we know this</p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight">The data behind the heatmap</h2>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            These windows come from published best-time-to-post studies covering millions of posts —
            not guesswork. Each cell is a 2-hour window scored by relative engagement; the darker the
            cell, the stronger the slot. It&apos;s the same industry baseline marketingmagic uses as a
            starting prior before it learns your own audience&apos;s rhythm.
          </p>
          {source ? (
            <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
              <span className="font-medium text-foreground/80">Sources:</span> {source}
            </p>
          ) : null}
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            Times are shown in your audience&apos;s local timezone. Treat these as a strong default —
            the real best time is whenever <em>your</em> followers are most active, which can differ.
          </p>
        </div>
      </section>

      {/* ─── CTA ─────────────────────────────────────────────────────────── */}
      <section className="container pb-20">
        <SignupCta
          headline={`Get posting times optimized for YOUR ${platform.label} audience`}
          body="marketingmagic measures when your real followers engage, then schedules every post into your peak windows automatically — across all 8 channels, from one queue."
        />
      </section>
    </ToolShell>
  );
}
