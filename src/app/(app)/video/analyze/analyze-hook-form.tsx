"use client";

import { useActionState } from "react";
import Link from "next/link";
import { Sparkles, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { analyzeHookAction, type AnalyzeHookState } from "./actions";
import type { VisualMoment } from "@/lib/video/analyze";

const initial: AnalyzeHookState = {
  error: null,
  analysis: null,
  provider: null,
  model: null,
  needsKeys: false,
};

// Thin "Analyze hook" affordance for a post that has a rendered video. Submits
// the post id to the server action and renders the structured DR breakdown
// inline. Stubbed: no re-analyse history view, no copy-to-clipboard — v1 just
// shows the latest pass.
export function AnalyzeHookForm({ postId }: { postId: string }) {
  const [state, action, pending] = useActionState(analyzeHookAction, initial);

  return (
    <div className="space-y-4">
      <form action={action}>
        <input type="hidden" name="postId" value={postId} />
        <Button type="submit" disabled={pending}>
          <Sparkles className="mr-1.5 h-4 w-4" aria-hidden />
          {pending ? "Analyzing…" : "Analyze hook"}
        </Button>
      </form>

      {state.error ? (
        <div className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div>
            <p>{state.error}</p>
            {state.needsKeys ? (
              <Link
                href="/settings/video-keys"
                className="mt-1 inline-block underline underline-offset-4"
              >
                Set up your analysis key →
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}

      {state.analysis ? <Breakdown state={state} /> : null}
    </div>
  );
}

function Breakdown({ state }: { state: AnalyzeHookState }) {
  const a = state.analysis!;
  return (
    <div className="space-y-4 rounded-lg border bg-muted/20 p-4 text-sm">
      <p className="text-xs text-muted-foreground">
        Analyzed with {state.provider ?? "?"} · {state.model ?? "?"}
      </p>

      <Field label="Spoken hook">{a.hook_spoken || <Muted />}</Field>
      <Field label="Visual hook">{a.hook_visual || <Muted />}</Field>
      <Field label="First 5 seconds">{a.visual_breakdown.firstFiveSeconds || <Muted />}</Field>

      <div className="space-y-1">
        <p className="font-medium">Pattern interrupts</p>
        {a.visual_breakdown.patternInterrupts.length ? (
          <ul className="ml-4 list-disc space-y-0.5 text-muted-foreground">
            {a.visual_breakdown.patternInterrupts.map((m: VisualMoment, i: number) => (
              <li key={i}>
                {typeof m.atSeconds === "number" ? `${m.atSeconds.toFixed(1)}s — ` : ""}
                {m.description}
              </li>
            ))}
          </ul>
        ) : (
          <Muted />
        )}
      </div>

      <div className="space-y-1">
        <p className="font-medium">On-screen text</p>
        {a.visual_breakdown.onScreenText.length ? (
          <ul className="ml-4 list-disc space-y-0.5 text-muted-foreground">
            {a.visual_breakdown.onScreenText.map((t: string, i: number) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        ) : (
          <Muted />
        )}
      </div>

      <Field label="Transcript">
        <span className="whitespace-pre-wrap text-muted-foreground">{a.transcript || <Muted />}</span>
      </Field>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <p className="font-medium">{label}</p>
      <p>{children}</p>
    </div>
  );
}

function Muted() {
  return <span className="text-muted-foreground italic">— none detected —</span>;
}
