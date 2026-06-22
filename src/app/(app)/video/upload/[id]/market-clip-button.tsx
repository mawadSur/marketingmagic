"use client";

// "Market this clip" — the editor-side control (slice E mounts this next to a
// finished clip). Opens a small inline panel where the user optionally narrows
// the target channels + adds an angle, then fires marketClipAction. On success
// it tells them how many posts landed in the queue (and why any channel was
// skipped: not connected, or not video-capable on this plan).
//
// Channels offered here are the deployment's video-capable set passed down from
// the server (intersection of VIDEO_PUBLISH_CHANNELS + the registry). Leaving
// every box checked targets all eligible connected channels.

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  marketClipAction,
  type MarketClipActionResult,
} from "./clip-market-actions";
import type { ChannelId } from "@/lib/channels/registry";

export function MarketClipButton({
  jobId,
  videoChannels,
}: {
  jobId: string;
  // The deployment's video-capable channels (VIDEO_PUBLISH_CHANNELS ∩ registry).
  videoChannels: ChannelId[];
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<ChannelId>>(new Set(videoChannels));
  const [context, setContext] = useState("");
  const [result, setResult] = useState<MarketClipActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  function toggle(ch: ChannelId) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(ch)) next.delete(ch);
      else next.add(ch);
      return next;
    });
  }

  function submit() {
    setResult(null);
    const channels = [...selected];
    startTransition(async () => {
      const res = await marketClipAction({
        jobId,
        channels: channels.length > 0 ? channels : undefined,
        captionContext: context.trim() || undefined,
      });
      setResult(res);
    });
  }

  if (!open) {
    return (
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        Market this clip
      </Button>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Market this clip</h3>
        <button
          type="button"
          className="text-xs text-muted-foreground hover:underline"
          onClick={() => setOpen(false)}
        >
          Close
        </button>
      </div>

      {videoChannels.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No channels can publish video on this plan yet.
        </p>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Where should we draft a post? (Only video-capable channels are shown.)
          </p>
          <div className="flex flex-wrap gap-3">
            {videoChannels.map((ch) => (
              <label key={ch} className="flex items-center gap-1.5 text-sm capitalize">
                <input
                  type="checkbox"
                  checked={selected.has(ch)}
                  onChange={() => toggle(ch)}
                  className="h-4 w-4"
                />
                {ch}
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-1">
        <label htmlFor="clip-angle" className="text-xs text-muted-foreground">
          Angle (optional)
        </label>
        <textarea
          id="clip-angle"
          value={context}
          onChange={(e) => setContext(e.target.value)}
          maxLength={500}
          rows={2}
          placeholder="e.g. lead with the surprising result"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>

      <div className="flex items-center gap-2">
        <Button type="button" onClick={submit} disabled={pending || videoChannels.length === 0}>
          {pending ? "Drafting…" : "Draft posts"}
        </Button>
        {result?.ok && (
          <span className="text-sm text-success">
            {result.created} post{result.created === 1 ? "" : "s"} added to your queue.
          </span>
        )}
        {result && !result.ok && result.error && (
          <span className="text-sm text-destructive">{result.error}</span>
        )}
      </div>

      {result?.ok && (
        <div className="flex flex-wrap gap-1.5 text-xs">
          {result.marketed.map((ch) => (
            <Badge key={ch} variant="success" className="capitalize">
              {ch}
            </Badge>
          ))}
          {result.skippedNotVideoCapable.map((ch) => (
            <Badge key={`nv-${ch}`} variant="muted" className="capitalize">
              {ch}: needs platform approval
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
