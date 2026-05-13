import Link from "next/link";
import { PartyPopper } from "lucide-react";

/**
 * Step 4: celebratory completion screen. Reached either by direct link
 * after plan generation or via the wizard URL with ?step=4.
 */
export function Step4Done() {
  return (
    <div className="space-y-8">
      <div className="flex flex-col items-center gap-4 rounded-lg border bg-muted/30 p-8 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
          <PartyPopper className="h-7 w-7" aria-hidden />
        </div>
        <div className="space-y-2">
          <h2 className="text-xl font-semibold">Your first plan is ready in the queue.</h2>
          <p className="mx-auto max-w-md text-sm text-muted-foreground">
            Approve the drafts you like, edit the ones that need a tweak, and skip anything that
            misses. Every approval teaches the system your voice.
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Link
          href="/queue"
          className="flex flex-col items-center justify-center gap-1 rounded-md bg-primary px-6 py-4 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <span>Review the queue</span>
          <span className="text-xs font-normal opacity-80">Approve your first posts</span>
        </Link>
        <Link
          href="/dashboard"
          className="flex flex-col items-center justify-center gap-1 rounded-md border px-6 py-4 text-sm font-medium hover:bg-accent"
        >
          <span>Go to dashboard</span>
          <span className="text-xs font-normal text-muted-foreground">See the calendar view</span>
        </Link>
      </div>
    </div>
  );
}
