import Link from "next/link";
import type { Metadata } from "next";
import { LandingForm } from "@/components/landing-form";
import { track } from "@/lib/preview/analytics";

export const metadata: Metadata = {
  title: "Get your preview plan — marketingmagic",
  description:
    "Paste your handle, see a 7-post posting plan written in your voice in 30 seconds. No signup.",
};

// Force this page to render dynamically so the funnel `landing_view` event
// fires per request rather than once at build time. Vercel Analytics
// captures client-side pageviews separately; this server-side event is for
// the structured funnel that joins to landing_submit / preview_generated.
export const dynamic = "force-dynamic";

// Public page. Anyone can hit this — no auth, no workspace.
export default function StartPage() {
  track({ stage: "landing_view" });
  return (
    <main className="relative flex min-h-screen flex-col">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-b from-muted/40 via-background to-background"
      />
      <div className="container flex flex-1 flex-col items-center justify-center gap-10 py-16">
        <div className="flex items-center gap-2 rounded-full border bg-background/80 px-3 py-1 text-xs text-muted-foreground backdrop-blur">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          30-second preview · no signup
        </div>

        <div className="max-w-2xl space-y-3 text-center">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            See what a week of posts sounds like in your voice.
          </h1>
          <p className="text-base text-muted-foreground sm:text-lg">
            Drop your handle. We pull a few of your posts (or you paste them),
            then generate a 7-post preview plan that reads like you wrote it.
          </p>
        </div>

        <div className="w-full max-w-lg rounded-xl border bg-card p-6 shadow-sm">
          <LandingForm />
        </div>

        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <Link href="/login" className="underline-offset-2 hover:underline">
            Already have an account? Log in
          </Link>
          <span aria-hidden>·</span>
          <Link href="/" className="underline-offset-2 hover:underline">
            What is marketingmagic?
          </Link>
        </div>
      </div>
    </main>
  );
}
