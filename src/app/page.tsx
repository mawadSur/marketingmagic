import Link from "next/link";

export default function HomePage() {
  return (
    <main className="relative flex min-h-screen flex-col">
      {/* Subtle background wash so the page has depth without art. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-b from-muted/40 via-background to-background"
      />
      <div className="container flex flex-1 flex-col items-center justify-center gap-8 py-16">
        <div className="flex items-center gap-2 rounded-full border bg-background/80 px-3 py-1 text-xs text-muted-foreground backdrop-blur">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          Auto-posting that doesn't sound like a robot
        </div>

        <div className="max-w-2xl space-y-4 text-center">
          <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
            marketingmagic
          </h1>
          <p className="text-base text-muted-foreground sm:text-lg">
            Auto-generated posting plans. Hybrid-approval auto-posting. Data-driven theme iteration.
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/start"
            className="inline-flex h-10 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-opacity duration-200 hover:opacity-90"
          >
            See a preview plan (30s, no signup)
          </Link>
          <Link
            href="/signup"
            className="inline-flex h-10 items-center rounded-md border border-input px-5 text-sm font-medium transition-colors duration-200 hover:bg-accent"
          >
            Sign up
          </Link>
          <Link
            href="/login"
            className="inline-flex h-10 items-center text-sm font-medium text-muted-foreground underline-offset-2 hover:underline"
          >
            Log in
          </Link>
        </div>
      </div>
    </main>
  );
}
