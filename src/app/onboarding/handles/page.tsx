import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { HandleFinder } from "./handle-finder";

export const dynamic = "force-dynamic";

// Handle-finder — helps a new user pick a brandable username and see where it's
// free across all 8 channels, with one-click "claim" links to each platform's
// signup. Lives in the onboarding flow (before connecting channels) so a user
// who doesn't yet have accounts can go make them.
export default async function HandlesPage() {
  await getActiveWorkspaceOrRedirect();

  return (
    <div className="mx-auto max-w-2xl space-y-8 py-8">
      <header className="space-y-2">
        <p className="label-eyebrow">Get set up</p>
        <h1 className="text-2xl font-semibold tracking-tight">
          Find your handle. Claim it everywhere.
        </h1>
        <p className="text-sm text-muted-foreground">
          One username across every platform makes you findable. We&apos;ll suggest brandable
          options, show where they&apos;re free, and link you straight to sign up.
        </p>
      </header>

      <HandleFinder />

      <div className="flex items-center justify-between border-t pt-6 text-sm">
        <Link
          href="/onboarding/wizard?step=2"
          className="text-muted-foreground transition-colors hover:text-foreground"
        >
          Already have accounts? Connect them
        </Link>
        <Link
          href="/onboarding/wizard?step=2"
          className="inline-flex items-center gap-1 font-medium text-foreground"
        >
          Next: connect channels
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </div>
    </div>
  );
}
