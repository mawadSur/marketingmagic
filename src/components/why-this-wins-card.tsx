"use client";

import * as React from "react";
import { useActionState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, ChannelBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  savePatternAction,
  type SavePatternState,
} from "@/app/(app)/plans/[id]/actions";
import type { ExplainerCard, ExplainerReason } from "@/lib/explain/schema";

export interface WhyThisWinsCardProps {
  postId: string;
  postText: string;
  channel: string;
  theme: string | null;
  postedAt: string;
  engagementRate: number;
  baseline: number;
  ratio: number;
  verdict: "winner" | "underperformer";
  card: ExplainerCard;
  defaultOpen?: boolean;
}

const initialState: SavePatternState = { ok: false, error: null };

const KIND_LABEL: Record<ExplainerReason["kind"], string> = {
  theme: "Theme",
  timing: "Timing",
  voice: "Voice",
  opener: "Opener",
  length: "Length",
  other: "Signal",
};

// Soft tone for underperformer cards — we don't want this surface to feel
// like a scolding. Borrowed palette from the empty-state component so it
// matches the existing dashboard mood.
function verdictStyles(verdict: "winner" | "underperformer") {
  if (verdict === "winner") {
    return {
      border: "border-emerald-500/30",
      tint: "bg-emerald-500/5",
      title: "text-emerald-700",
      label: "Outperformed your baseline",
    };
  }
  return {
    border: "border-amber-500/30",
    tint: "bg-amber-500/5",
    title: "text-amber-700",
    label: "Softer than your baseline",
  };
}

export function WhyThisWinsCard(props: WhyThisWinsCardProps) {
  const [open, setOpen] = React.useState(props.defaultOpen ?? false);
  const styles = verdictStyles(props.verdict);
  const ratioLabel =
    props.verdict === "winner"
      ? `${props.ratio.toFixed(2)}× your baseline`
      : `${(props.ratio * 100).toFixed(0)}% of your baseline`;

  return (
    <Card className={cn("border", styles.border, styles.tint)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full text-left"
      >
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <p className="label-eyebrow">Why this post</p>
              <CardTitle className={cn("text-sm font-medium", styles.title)}>
                {styles.label} — {ratioLabel}
              </CardTitle>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <ChannelBadge channel={props.channel} />
              {props.theme ? <Badge variant="muted">#{props.theme}</Badge> : null}
              <span className="tabular-nums">
                {props.postedAt.slice(0, 16).replace("T", " ")}
              </span>
              <span aria-hidden className="ml-1 select-none">
                {open ? "▾" : "▸"}
              </span>
            </div>
          </div>
        </CardHeader>
      </button>

      {open ? (
        <CardContent className="space-y-4 pt-0">
          <p className="line-clamp-3 whitespace-pre-wrap rounded-md border bg-background/60 p-3 text-sm leading-relaxed">
            {props.postText}
          </p>

          <div className="space-y-2">
            <p className="label-eyebrow">Possible reasons</p>
            <ul className="space-y-2">
              {props.card.reasons.map((reason, i) => (
                <ReasonRow
                  key={i}
                  reason={reason}
                  postId={props.postId}
                  summary={props.card.pattern_summary}
                  // Pattern data captures the structured fields a saved
                  // pattern should reference at plan-generation time.
                  data={{
                    detail: reason.detail,
                    theme: props.theme,
                    channel: props.channel,
                    posted_at: props.postedAt,
                    engagement_rate: props.engagementRate,
                    baseline: props.baseline,
                    ratio: props.ratio,
                    verdict: props.verdict,
                  }}
                  savable={props.verdict === "winner"}
                />
              ))}
            </ul>
          </div>

          {props.verdict === "winner" ? (
            <SavePatternRow
              postId={props.postId}
              summary={props.card.pattern_summary}
              data={{
                summary: props.card.pattern_summary,
                theme: props.theme,
                channel: props.channel,
                posted_at: props.postedAt,
                engagement_rate: props.engagementRate,
                ratio: props.ratio,
              }}
            />
          ) : (
            <p className="text-xs text-muted-foreground">
              Use this as a note, not a verdict — engagement varies week to week.
            </p>
          )}
        </CardContent>
      ) : null}
    </Card>
  );
}

function ReasonRow({
  reason,
  postId,
  summary,
  data,
  savable,
}: {
  reason: ExplainerReason;
  postId: string;
  summary: string;
  data: Record<string, unknown>;
  savable: boolean;
}) {
  const [state, formAction, pending] = useActionState(savePatternAction, initialState);
  const saved = state.ok;

  return (
    <li className="flex items-start justify-between gap-3 text-sm">
      <div className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {KIND_LABEL[reason.kind]}
        </p>
        <p className="leading-relaxed">{reason.detail}</p>
      </div>
      {savable ? (
        <form action={formAction} className="shrink-0">
          <input type="hidden" name="postId" value={postId} />
          <input type="hidden" name="patternKind" value={reason.kind} />
          <input type="hidden" name="summary" value={summary} />
          <input
            type="hidden"
            name="data"
            value={JSON.stringify({ ...data, pattern_kind: reason.kind })}
          />
          <Button
            type="submit"
            size="sm"
            variant={saved ? "secondary" : "outline"}
            disabled={pending || saved}
            title={saved ? "Saved to playbook." : "Save this reason as a pattern to lean into next plan."}
          >
            {saved ? "Saved" : pending ? "Saving…" : "Save"}
          </Button>
        </form>
      ) : null}
    </li>
  );
}

function SavePatternRow({
  postId,
  summary,
  data,
}: {
  postId: string;
  summary: string;
  data: Record<string, unknown>;
}) {
  const [state, formAction, pending] = useActionState(savePatternAction, initialState);
  const saved = state.ok;

  return (
    <form
      action={formAction}
      className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-background/60 p-3"
    >
      <div className="min-w-0 space-y-0.5">
        <p className="label-eyebrow">Pattern summary</p>
        <p className="text-sm">{summary}</p>
      </div>
      <input type="hidden" name="postId" value={postId} />
      <input type="hidden" name="patternKind" value="other" />
      <input type="hidden" name="summary" value={summary} />
      <input type="hidden" name="data" value={JSON.stringify(data)} />
      <Button type="submit" size="sm" disabled={pending || saved}>
        {saved ? "Saved to playbook" : pending ? "Saving…" : "Save pattern"}
      </Button>
      {state.error ? (
        <p className="basis-full text-xs text-destructive">{state.error}</p>
      ) : null}
    </form>
  );
}
