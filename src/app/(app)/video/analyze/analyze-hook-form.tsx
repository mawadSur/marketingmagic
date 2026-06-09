"use client";

import { useActionState } from "react";
import Link from "next/link";
import { Sparkles, AlertCircle, Lightbulb } from "lucide-react";
import { Button } from "@/components/ui/button";
import { analyzeHookAction, type AnalyzeHookState } from "./actions";
import type { VisualMoment, HookRating, HookCriterion } from "@/lib/video/analyze";

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

      {a.hook_rating ? <HookRatingCard rating={a.hook_rating} /> : null}

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

// The headline grade: a big 0–100 hook score, the one-line verdict, the
// per-dimension sub-scores as bars, and concrete fixes. This is the "rating"
// the user asked for — the number that says which clip stops the scroll.
function HookRatingCard({ rating }: { rating: HookRating }) {
  const tone = scoreTone(rating.score);
  return (
    <div className={`space-y-3 rounded-lg border p-4 ${tone.border} ${tone.bg}`}>
      <div className="flex items-baseline gap-3">
        <span className={`text-3xl font-bold tabular-nums ${tone.text}`}>{rating.score}</span>
        <span className="text-sm text-muted-foreground">/ 100 hook strength</span>
        <span className={`ml-auto rounded-full px-2 py-0.5 text-xs font-medium ${tone.pill}`}>
          {tone.label}
        </span>
      </div>

      {rating.verdict ? <p className="text-sm font-medium">{rating.verdict}</p> : null}

      {rating.criteria.length ? (
        <div className="space-y-1.5">
          {rating.criteria.map((c: HookCriterion) => (
            <div key={c.key} className="space-y-0.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium" title={c.reason || undefined}>
                  {c.label}
                </span>
                <span className="tabular-nums text-muted-foreground">{c.score}/10</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-foreground/70"
                  style={{ width: `${Math.max(0, Math.min(10, c.score)) * 10}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {rating.improvements.length ? (
        <div className="space-y-1">
          <p className="flex items-center gap-1.5 text-xs font-medium">
            <Lightbulb className="h-3.5 w-3.5" aria-hidden />
            How to make it stronger
          </p>
          <ul className="ml-5 list-disc space-y-0.5 text-xs text-muted-foreground">
            {rating.improvements.map((t: string, i: number) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

// Map a 0–100 score to a colour band + label. Tough-grader thresholds: 80+ is a
// genuine scroll-stopper, 60–79 solid, 40–59 weak, below 40 needs a rewrite.
function scoreTone(score: number): {
  label: string;
  border: string;
  bg: string;
  text: string;
  pill: string;
} {
  if (score >= 80)
    return {
      label: "Scroll-stopper",
      border: "border-emerald-500/40",
      bg: "bg-emerald-500/5",
      text: "text-emerald-600 dark:text-emerald-400",
      pill: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    };
  if (score >= 60)
    return {
      label: "Solid",
      border: "border-sky-500/40",
      bg: "bg-sky-500/5",
      text: "text-sky-600 dark:text-sky-400",
      pill: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
    };
  if (score >= 40)
    return {
      label: "Weak",
      border: "border-amber-500/40",
      bg: "bg-amber-500/5",
      text: "text-amber-600 dark:text-amber-400",
      pill: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    };
  return {
    label: "Rewrite it",
    border: "border-destructive/40",
    bg: "bg-destructive/5",
    text: "text-destructive",
    pill: "bg-destructive/15 text-destructive",
  };
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
