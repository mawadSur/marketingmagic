"use client";

import { Logo } from "@/components/ui/logo";
import { Button } from "@/components/ui/button";

// Global error boundary. This is the *last resort* fallback: it fires when the
// root layout itself throws, so it must render its own <html>/<body> (Next.js
// replaces the root layout when this renders). Kept self-contained and minimal.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background font-sans antialiased">
        <main className="container flex min-h-screen items-center justify-center py-16">
          <div className="w-full max-w-sm space-y-6 text-center">
            <span className="mx-auto inline-flex">
              <Logo variant="full" size="lg" />
            </span>
            <div className="space-y-1">
              <h1 className="text-3xl font-semibold tracking-tight">
                Something went wrong
              </h1>
              <p className="text-sm text-muted-foreground">
                An unexpected error occurred. Please try again.
                {error.digest ? (
                  <span className="mt-1 block text-xs text-muted-foreground/70">
                    Reference: {error.digest}
                  </span>
                ) : null}
              </p>
            </div>
            <Button onClick={() => reset()}>Try again</Button>
          </div>
        </main>
      </body>
    </html>
  );
}
