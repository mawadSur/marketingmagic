"use client";

// Auto-tags (migration 052) — per-post editable tag chips.
//
// Renders below the hashtag-hint row in /queue. Unlike HashtagPillRow (which
// surfaces RECOMMENDATIONS from history and writes the inline #block), this
// row is bound to the STRUCTURED posts.tags column:
//   • chips reflect the auto-generated tag set (and any user edits)
//   • toggling a chip off removes it; the user can also clear all
//   • "Regenerate" re-runs the generator for this draft
//   • "Save tags" persists via setPostTagsAction (column + inline mirror)
//
// Channel policy is the hard gate, same as HashtagPillRow:
//   • Bluesky (showChips=false) → render the explainer, no chips
//   • the channel cap from rules.ts is the binding ceiling

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import type { ChannelId } from "@/lib/channels/registry";
import { getChannelHashtagPolicy, igTagTierFor } from "@/lib/hashtags/rules";
import { setPostTagsAction, regeneratePostTagsAction } from "@/app/(app)/queue/actions";

interface Props {
  postId: string;
  channel: ChannelId;
  // The post's current structured tags (posts.tags). Auto-filled by the
  // generator at plan time; the user can toggle/clear/regenerate.
  initialTags: string[];
}

export function TagChipRow({ postId, channel, initialTags }: Props) {
  const policy = getChannelHashtagPolicy(channel);
  const router = useRouter();
  const [pending, start] = useTransition();
  const [regenBusy, regenStart] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Local working set of tags (starts from the stored column).
  const [tags, setTags] = useState<string[]>(() => initialTags);

  // Bluesky: tags don't belong — render the rule explainer only.
  if (!policy.showChips || policy.recommendedCount[1] === 0) {
    return (
      <div className="rounded-md border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Tags off:</span> {policy.notes}
      </div>
    );
  }

  const max = policy.recommendedCount[1];

  function removeTag(tag: string) {
    setError(null);
    setTags((prev) => prev.filter((t) => t !== tag));
  }

  function clearAll() {
    setError(null);
    setTags([]);
  }

  function save() {
    start(async () => {
      const result = await setPostTagsAction(postId, tags);
      if (result.error) {
        setError(result.error);
        return;
      }
      setError(null);
      setTags(result.tags);
      router.refresh();
    });
  }

  function regenerate() {
    setError(null);
    regenStart(async () => {
      const result = await regeneratePostTagsAction(postId);
      if (result.error) {
        setError(result.error);
        return;
      }
      setTags(result.tags);
      router.refresh();
    });
  }

  const overCap = tags.length > max;

  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Tags (auto-generated):</span> {policy.notes}
        </p>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <span className={cn("tabular-nums", overCap && "text-destructive")}>
            {tags.length}/{max}
          </span>
          <button
            type="button"
            onClick={regenerate}
            disabled={regenBusy || pending}
            className="inline-flex h-7 items-center rounded-md border bg-background px-2.5 text-xs font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {regenBusy ? "Generating…" : "Regenerate"}
          </button>
          <button
            type="button"
            onClick={save}
            disabled={pending || regenBusy || overCap}
            className="inline-flex h-7 items-center rounded-md border bg-background px-2.5 text-xs font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save tags"}
          </button>
        </div>
      </div>

      {tags.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">
          No tags yet — hit Regenerate to auto-fill, or add some inline in the post (e.g.{" "}
          <code>#launch</code>).
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          {tags.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => removeTag(tag)}
              disabled={pending || regenBusy}
              title="Remove this tag"
              className={cn(
                "group inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                "border-primary/60 bg-primary/10 text-primary hover:border-destructive/60 hover:bg-destructive/10 hover:text-destructive",
                (pending || regenBusy) && "opacity-50",
              )}
            >
              <span className="font-medium">#{tag}</span>
              {channel === "instagram" ? (
                <span className="text-[9px] uppercase tracking-wide text-muted-foreground">
                  {igTagTierFor(tag)}
                </span>
              ) : null}
              <span aria-hidden className="text-[10px] leading-none">
                ×
              </span>
            </button>
          ))}
          {tags.length > 0 ? (
            <button
              type="button"
              onClick={clearAll}
              disabled={pending || regenBusy}
              className="text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
            >
              Clear all
            </button>
          ) : null}
        </div>
      )}

      {overCap ? (
        <p className="text-xs text-destructive">
          {channel.toUpperCase()} caps at {max} tag{max === 1 ? "" : "s"} — remove{" "}
          {tags.length - max} before saving.
        </p>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
