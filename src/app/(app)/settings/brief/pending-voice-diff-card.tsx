"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import type { VoiceProfileDiff } from "@/lib/db/types";
import { acceptVoiceDiffAction, dismissVoiceDiffAction } from "./actions";

interface Props {
  diff: VoiceProfileDiff;
  proposedAt: string | null;
}

// Banner shown above the brief form when the weekly voice-evolution cron
// has proposed a diff. User accepts (merge into voice_profile, null the
// diff) or dismisses (just null the diff).
export function PendingVoiceDiffCard({ diff, proposedAt }: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(fn: () => Promise<{ error: string | null }>) {
    setError(null);
    start(async () => {
      const result = await fn();
      if (result.error) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-50/60 p-4 dark:border-amber-500/40 dark:bg-amber-950/30">
      <div className="flex items-center gap-2">
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-amber-500 text-[10px] font-bold text-white">
          !
        </span>
        <span className="text-sm font-medium">Voice profile update suggested</span>
      </div>
      <p className="text-sm text-muted-foreground">{diff.rationale}</p>
      <DiffPreview diff={diff} />
      {proposedAt ? (
        <p className="text-[11px] text-muted-foreground">
          Proposed {new Date(proposedAt).toLocaleString()} from{" "}
          {diff.source_rejection_count} rejection
          {diff.source_rejection_count === 1 ? "" : "s"} in the last week.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={pending}
          onClick={() => run(acceptVoiceDiffAction)}
        >
          {pending ? "Applying…" : "Apply update"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => run(dismissVoiceDiffAction)}
        >
          Dismiss
        </Button>
        {error ? <span className="text-xs text-destructive">{error}</span> : null}
      </div>
    </div>
  );
}

function DiffPreview({ diff }: { diff: VoiceProfileDiff }) {
  const rows: Array<{ label: string; node: React.ReactNode }> = [];

  if (diff.add_do_not_say && diff.add_do_not_say.length > 0) {
    rows.push({ label: "Add to avoid", node: <Chips items={diff.add_do_not_say} tone="destructive" /> });
  }
  if (diff.remove_do_not_say && diff.remove_do_not_say.length > 0) {
    rows.push({ label: "Stop avoiding", node: <Chips items={diff.remove_do_not_say} tone="muted" /> });
  }
  if (diff.add_signature_phrases && diff.add_signature_phrases.length > 0) {
    rows.push({ label: "New signatures", node: <Chips items={diff.add_signature_phrases} tone="muted" /> });
  }
  if (diff.remove_signature_phrases && diff.remove_signature_phrases.length > 0) {
    rows.push({ label: "Drop signatures", node: <Chips items={diff.remove_signature_phrases} tone="muted" /> });
  }
  if (diff.formality) {
    rows.push({ label: "Formality →", node: <Pill>{diff.formality}</Pill> });
  }
  if (diff.emoji_usage) {
    rows.push({ label: "Emoji →", node: <Pill>{diff.emoji_usage}</Pill> });
  }
  if (diff.summary_patch) {
    rows.push({
      label: "New summary",
      node: <p className="text-xs text-foreground">{diff.summary_patch}</p>,
    });
  }

  if (rows.length === 0) return null;

  return (
    <div className="space-y-2 rounded-md border bg-background/60 p-3">
      {rows.map((r) => (
        <div key={r.label} className="flex flex-wrap items-start gap-2 text-xs">
          <span className="min-w-[7rem] text-muted-foreground">{r.label}</span>
          <div className="flex-1">{r.node}</div>
        </div>
      ))}
    </div>
  );
}

function Chips({ items, tone }: { items: string[]; tone: "muted" | "destructive" }) {
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((s) => (
        <span
          key={s}
          className={
            tone === "destructive"
              ? "rounded-md border border-destructive/30 bg-destructive/5 px-2 py-0.5 text-xs text-destructive"
              : "rounded-md border bg-muted px-2 py-0.5 text-xs"
          }
        >
          {s}
        </span>
      ))}
    </div>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-md border bg-muted px-2 py-0.5 text-xs">{children}</span>
  );
}
