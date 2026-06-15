// /tools — public "Free tools" hub. Integration glue tying together the
// individual tool surfaces (handle-checker, best-time-to-post) into one
// discoverable, indexable landing. Reuses the marketing ToolShell built for the
// best-time tool so the chrome matches the public design system. Deliberately
// NOT a /tools/layout.tsx — each tool page renders its own nav/footer, so a
// layout-level shell would double the chrome.
import type { Metadata } from "next";
import Link from "next/link";
import { AtSign, Clock, ArrowRight } from "lucide-react";
import { ToolShell, SignupCta } from "./best-time-to-post/shell";

export const metadata: Metadata = {
  title: "Free Tools for Creators & Social Marketers · marketingmagic",
  description:
    "Free, no-signup tools from marketingmagic: check if your brand name is available across 8 social platforms, and find the best time to post on each. Built on the same intelligence that powers our AI scheduler.",
  alternates: { canonical: "/tools" },
  robots: { index: true, follow: true },
  openGraph: {
    title: "Free Tools for Creators & Social Marketers",
    description:
      "Check brand-name availability across 8 platforms and find the best time to post — free, no signup.",
    type: "website",
  },
};

const TOOLS = [
  {
    href: "/tools/handle-checker",
    icon: AtSign,
    name: "Social Handle Checker",
    blurb:
      "Type a brand name and instantly see if the handle is free across all 8 major platforms — X, Instagram, TikTok, YouTube, LinkedIn, Threads, Facebook, and Bluesky.",
    cta: "Check a name",
  },
  {
    href: "/tools/best-time-to-post",
    icon: Clock,
    name: "Best Time to Post",
    blurb:
      "See the highest-engagement posting windows for each platform, backed by real industry data — rendered as a clear weekly heatmap. No fluff, no signup.",
    cta: "See the windows",
  },
];

export default function ToolsHubPage() {
  return (
    <ToolShell>
      <section className="container flex-1 py-16 sm:py-24">
        <div className="mx-auto max-w-2xl text-center">
          <p className="label-eyebrow text-muted-foreground">Free tools</p>
          <h1 className="mt-3 text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
            Free tools for social marketers
          </h1>
          <p className="mt-4 text-pretty text-base text-muted-foreground sm:text-lg">
            No signup, no catch. Built on the same intelligence that powers the marketingmagic
            AI scheduler — try them, then let us run the whole thing for you.
          </p>
        </div>

        <ul className="mx-auto mt-12 grid max-w-4xl gap-5 sm:grid-cols-2">
          {TOOLS.map((t) => {
            const Icon = t.icon;
            return (
              <li key={t.href}>
                <Link
                  href={t.href}
                  className="group flex h-full flex-col rounded-2xl border bg-card p-6 transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Icon className="h-5 w-5" aria-hidden />
                  </span>
                  <h2 className="mt-4 text-lg font-semibold tracking-tight">{t.name}</h2>
                  <p className="mt-2 flex-1 text-sm text-muted-foreground">{t.blurb}</p>
                  <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-primary">
                    {t.cta}
                    <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>

        <div className="mx-auto mt-16 max-w-4xl">
          <SignupCta
            headline="Stop guessing. Let marketingmagic run it."
            body="These tools are a taste. The full product plans a week of posts in your voice, publishes across every channel, and learns what works — automatically."
          />
        </div>
      </section>
    </ToolShell>
  );
}
