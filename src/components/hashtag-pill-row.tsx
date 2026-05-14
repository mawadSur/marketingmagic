"use client";

// Phase 6.10 — per-post hashtag chip row.
//
// Renders below the post text editor in /queue. Chips are pre-checked
// for tags the recommender ranks highest within the channel's policy
// max. Toggling a chip calls setPostHashtagsAction, which rewrites the
// draft body with the new tag list appended in a trailing block.
//
// Hard rules:
// - On Bluesky we render nothing (channel rule: 0 tags). The parent
//   doesn't even mount this component for Bluesky, but we double-check
//   here so future callers can't accidentally bypass.
// - On X we never pre-check more than 0 (default empty). Historical
//   posts may have tags, but the algorithm penalizes them.
// - The channel cap from rules.ts is the hard ceiling — checked chips
//   above the cap are visually blocked from being added.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import type { ChannelId } from "@/lib/channels/registry";
import type { HashtagSuggestion } from "@/lib/hashtags/schema";
import { getChannelHashtagPolicy, igTagTierFor } from "@/lib/hashtags/rules";
import { setPostHashtagsAction } from "@/app/(app)/queue/actions";

interface Props {
  postId: string;
  channel: ChannelId;
  suggestions: HashtagSuggestion[];
  // Tags already in the post body. Pre-check state is computed from
  // (initialTags ∪ recommended-up-to-min). On X the initial state is
  // the empty set unless the user has explicitly added a tag — keeps
  // X drafts hashtag-free by default.
  initialTags: string[];
}

export function HashtagPillRow({ postId, channel, suggestions, initialTags }: Props) {
  const policy = getChannelHashtagPolicy(channel);
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Bluesky: render the rule-explainer only, no chips.
  if (!policy.showChips) {
    return (
      <div className="rounded-md border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Hashtags off:</span> {policy.notes}
      </div>
    );
  }

  // X: hard-default to "no checked tags" regardless of suggestions.
  // The user can still opt-in by clicking a chip.
  const preCheckTarget = channel === "x" ? 0 : policy.recommendedCount[0];

  const allChips = mergeChips(suggestions, initialTags, preCheckTarget);
  const initialChecked = new Set(initialTags);
  // If the post body itself has no tags yet, pre-check the top N
  // suggestions per the channel policy minimum. This is the "default"
  // recommendation surface — user retains full toggle control.
  if (initialTags.length === 0 && preCheckTarget > 0) {
    for (const c of allChips.slice(0, preCheckTarget)) initialChecked.add(c.tag);
  }
  const [checked, setChecked] = useState<Set<string>>(initialChecked);

  const max = policy.recommendedCount[1];
  const overCap = checked.size > max;

  function toggle(tag: string) {
    setError(null);
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) {
        next.delete(tag);
      } else {
        if (next.size >= max) {
          setError(`${policy.channel.toUpperCase()} caps at ${max} tag${max === 1 ? "" : "s"} — uncheck one first.`);
          return prev;
        }
        next.add(tag);
      }
      return next;
    });
  }

  function applyTags() {
    start(async () => {
      const result = await setPostHashtagsAction(postId, Array.from(checked));
      if (result.error) {
        setError(result.error);
        return;
      }
      setError(null);
      router.refresh();
    });
  }

  const orderedChips = allChips;
  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Hashtag hints:</span> {policy.notes}
        </p>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <span className="tabular-nums">
            {checked.size}/{max}
          </span>
          <button
            type="button"
            onClick={applyTags}
            disabled={pending || overCap}
            className={cn(
              "inline-flex h-7 items-center rounded-md border px-2.5 text-xs font-medium transition-colors",
              "bg-background hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {pending ? "Saving…" : "Apply tags"}
          </button>
        </div>
      </div>

      {orderedChips.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">
          No tag history yet — type one inline (e.g. <code>#launch</code>) and it'll feed future suggestions.
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {orderedChips.map((chip) => {
            const isChecked = checked.has(chip.tag);
            return (
              <button
                key={chip.tag}
                type="button"
                onClick={() => toggle(chip.tag)}
                disabled={pending}
                title={titleFor(chip, channel)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                  isChecked
                    ? "border-primary/60 bg-primary/10 text-primary"
                    : "border-border bg-background text-foreground/70 hover:bg-muted",
                  pending && "opacity-50",
                )}
              >
                <span className="font-medium">#{chip.tag}</span>
                {channel === "instagram" ? (
                  <span className="text-[9px] uppercase tracking-wide text-muted-foreground">
                    {igTagTierFor(chip.tag)}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

/**
 * Merge the recommender's suggestions with whatever tags are already in
 * the post body, preserving the recommender order for unseen tags but
 * always surfacing draft-tags first so the user can see what's already
 * there.
 */
function mergeChips(
  suggestions: HashtagSuggestion[],
  initialTags: string[],
  preCheckTarget: number,
): HashtagSuggestion[] {
  const out: HashtagSuggestion[] = [];
  const seen = new Set<string>();
  // Draft tags come first so the user sees them at the start of the row.
  for (const t of initialTags) {
    if (seen.has(t)) continue;
    seen.add(t);
    const fromRec = suggestions.find((s) => s.tag === t);
    out.push(
      fromRec ?? {
        tag: t,
        channel: suggestions[0]?.channel ?? ("x" as ChannelId),
        confidence: 1.0,
        reason: "draft_match",
      },
    );
  }
  for (const s of suggestions) {
    if (seen.has(s.tag)) continue;
    seen.add(s.tag);
    out.push(s);
  }
  // Cap total chips at a reasonable max so the row doesn't sprawl. IG
  // legitimately wants up to 15, so we honor the policy max + a few
  // spares so the user has alternatives. Pre-checked targets fall well
  // within this range.
  const ROW_HARD_MAX = 18;
  void preCheckTarget; // signature compatibility
  return out.slice(0, ROW_HARD_MAX);
}

function titleFor(chip: HashtagSuggestion, channel: ChannelId): string {
  const parts: string[] = [];
  switch (chip.reason) {
    case "workspace_winner":
      parts.push("Top performer from your tag history");
      break;
    case "workspace_recent":
      parts.push("Used recently in this workspace");
      break;
    case "channel_default":
      parts.push(`${channel.toUpperCase()} default — workspace history is thin`);
      break;
    case "draft_match":
      parts.push("Already in this draft");
      break;
  }
  if (chip.sample_size) parts.push(`${chip.sample_size} past post${chip.sample_size === 1 ? "" : "s"}`);
  return parts.join(" · ");
}
