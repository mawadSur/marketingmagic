import Link from "next/link";

export default function HomePage() {
  return (
    <main className="container flex min-h-screen flex-col items-center justify-center gap-6 py-16">
      <div className="max-w-2xl space-y-4 text-center">
        <h1 className="text-4xl font-bold tracking-tight">marketingmagic</h1>
        <p className="text-muted-foreground">
          Auto-generated posting plans. Hybrid-approval auto-posting. Data-driven theme iteration.
        </p>
      </div>
      <div className="flex gap-3">
        <Link
          href="/login"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Log in
        </Link>
        <Link
          href="/signup"
          className="rounded-md border border-input px-4 py-2 text-sm font-medium hover:bg-accent"
        >
          Sign up
        </Link>
      </div>
    </main>
  );
}
