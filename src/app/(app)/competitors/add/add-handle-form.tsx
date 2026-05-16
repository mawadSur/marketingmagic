"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  COMPETITOR_CHANNELS,
  isCompetitorChannelSupported,
} from "@/lib/competitors/schema";
import type { CompetitorWatchChannel } from "@/lib/db/types";
import { addWatchHandleAction, type AddWatchHandleState } from "../actions";

const initial: AddWatchHandleState = { error: null, ok: false };

const CHANNEL_LABELS: Record<CompetitorWatchChannel, string> = {
  bluesky: "Bluesky",
  x: "X",
  linkedin: "LinkedIn",
  instagram: "Instagram",
  threads: "Threads",
};

export function AddHandleForm() {
  const [state, formAction, pending] = useActionState(addWatchHandleAction, initial);
  const [channel, setChannel] = useState<CompetitorWatchChannel>("bluesky");
  const supported = isCompetitorChannelSupported(channel);

  return (
    <form action={formAction} className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="channel">Channel</Label>
        <select
          id="channel"
          name="channel"
          value={channel}
          onChange={(e) => setChannel(e.target.value as CompetitorWatchChannel)}
          className="flex h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          {COMPETITOR_CHANNELS.map((c) => (
            <option key={c} value={c}>
              {CHANNEL_LABELS[c]}
              {isCompetitorChannelSupported(c) ? "" : " — coming soon"}
            </option>
          ))}
        </select>
        {!supported ? (
          <p className="text-xs text-muted-foreground">
            We&apos;ll save the handle but skipping daily pulls until
            {" "}
            {CHANNEL_LABELS[channel]}&apos;s public-read API allows it.
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="handle">Handle</Label>
        <Input
          id="handle"
          name="handle"
          required
          placeholder={
            channel === "bluesky" ? "alice.bsky.social or alice" : "username (no @)"
          }
          className="text-sm"
        />
        <p className="text-xs text-muted-foreground">
          {channel === "bluesky"
            ? "Bare usernames are coerced to *.bsky.social."
            : "Lowercase, no leading @."}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="display_name">Display name (optional)</Label>
        <Input
          id="display_name"
          name="display_name"
          placeholder="Pretty label for the watch list"
          className="text-sm"
        />
      </div>

      {state.error ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {state.error}
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Adding…" : "Watch this handle"}
        </Button>
        <Link
          href="/competitors"
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          Cancel
        </Link>
      </div>

      <p className="border-t pt-4 text-xs text-muted-foreground">
        Competitor Watch is read-only. We&apos;ll never follow, message, quote-tweet,
        or otherwise act on the handles you add. Draft responses are framed as
        constructive add-ons; takedown framings are blocked.
      </p>
    </form>
  );
}
