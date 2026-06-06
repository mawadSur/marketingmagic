"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";

// In-app error boundary. Renders *inside* the authed shell (header + container
// already painted by the (app) layout), so it stays in the content flow rather
// than taking over the full viewport.
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed bg-muted/20 px-6 py-16 text-center">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          Something went wrong
        </h1>
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">
          We hit an unexpected error loading this page. You can try again, or
          head back to your dashboard.
          {error.digest ? (
            <span className="mt-1 block text-xs text-muted-foreground/70">
              Reference: {error.digest}
            </span>
          ) : null}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
        <Button onClick={() => reset()}>Try again</Button>
        <Button asChild variant="outline">
          <Link href="/dashboard">Back to dashboard</Link>
        </Button>
      </div>
    </div>
  );
}
