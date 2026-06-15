import Link from "next/link";
import { Button } from "@/components/ui/button";

/**
 * Prominent "connect → fill your queue" CTA for the channels settings page.
 *
 * Attacks the channel→draft cliff: a user who connects a channel OUTSIDE the
 * onboarding wizard (here in settings) has a live place to post but nothing in
 * their queue, and nothing nudging them to generate it. This card sits at the
 * TOP of the page and links straight to the existing plan generator
 * (`/onboarding/wizard?step=3`).
 *
 * Render only when the workspace has >=1 CONNECTED channel AND zero
 * posting_plans — the page owns that gating; this component is purely
 * presentational so it stays trivial to test and reuse.
 */
export function FirstPlanCta() {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-primary/30 bg-primary/5 p-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="space-y-1">
        <p className="text-base font-medium">You&apos;re connected — now fill your queue</p>
        <p className="max-w-xl text-sm text-muted-foreground">
          Generate a week of ready-to-approve posts in one click.
        </p>
      </div>
      <Button asChild className="shrink-0">
        <Link href="/onboarding/wizard?step=3">Fill your queue →</Link>
      </Button>
    </div>
  );
}
