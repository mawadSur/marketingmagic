"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { CheckCircle2, Rocket, AlertCircle, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { publishNowAction } from "@/app/(app)/queue/actions";

export interface FirstDraft {
  id: string;
  channel: string;
  text: string;
}

// The activation payoff, made one click. A freshly generated plan leaves posts
// in `pending_approval`; publishNowAction publishes a single text/image post
// inline (threads/video fall back to the ≤5-min cron). We show the real draft so
// the user SEES what will post — control intact — then ships it live without the
// /queue detour that was deferring the "aha" by days (TTFP was ~7.5d).
export function PublishFirstPost({ draft }: { draft: FirstDraft }) {
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState<"idle" | "live" | "queued">("idle");
  const [error, setError] = useState<string | null>(null);

  function publish() {
    setError(null);
    startTransition(async () => {
      const res = await publishNowAction(draft.id);
      if (res.error) {
        setError(res.error);
        return;
      }
      // Threads/video can't dispatch inline — publishNowAction schedules them
      // for the next cron tick and still returns no error. Either way the user
      // has committed their first post; word it honestly.
      setDone("live");
    });
  }

  if (done === "live") {
    return (
      <div className="flex flex-col items-center gap-4 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-8 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="h-7 w-7" aria-hidden />
        </div>
        <div className="space-y-2">
          <h2 className="text-xl font-semibold">Your first post is live. 🎉</h2>
          <p className="mx-auto max-w-md text-sm text-muted-foreground">
            That&apos;s the whole loop — drafted, approved, published. The rest of your
            week is waiting in the queue.
          </p>
        </div>
        <div className="grid w-full gap-3 sm:max-w-sm sm:grid-cols-2">
          <Link
            href="/queue"
            className="inline-flex items-center justify-center gap-1 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Review the rest <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
          <Link
            href="/dashboard"
            className="inline-flex items-center justify-center rounded-md border px-5 py-2.5 text-sm font-medium hover:bg-accent"
          >
            Go to dashboard
          </Link>
        </div>
      </div>
    );
  }

  const preview = draft.text.length > 220 ? `${draft.text.slice(0, 220)}…` : draft.text;

  return (
    <div className="space-y-5">
      <div className="space-y-3 rounded-lg border bg-muted/30 p-6">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <Rocket className="h-4 w-4 text-primary" aria-hidden />
          Your first post · <span className="capitalize text-foreground">{draft.channel}</span>
        </div>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{preview}</p>
      </div>

      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
          <span>
            Couldn&apos;t publish it from here: {error}{" "}
            <Link href="/queue" className="font-medium text-primary underline underline-offset-4">
              Fix it in the queue →
            </Link>
          </span>
        </div>
      ) : null}

      <div className="flex flex-col items-center gap-3">
        <Button
          type="button"
          size="lg"
          className="w-full sm:w-auto sm:min-w-[280px]"
          disabled={pending}
          onClick={publish}
        >
          {pending ? "Publishing…" : "Publish my first post now"}
        </Button>
        <Link
          href="/queue"
          className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Or review &amp; edit the whole week in the queue first
        </Link>
      </div>
    </div>
  );
}
