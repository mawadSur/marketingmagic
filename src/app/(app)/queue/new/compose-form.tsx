"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { channelSpec } from "@/lib/channels/registry";
import { createDraftPostAction } from "../compose-actions";

export interface ConnectedChannel {
  channel: string;
  label: string;
  handle: string;
}

// Single-post compose form. Pick one of the workspace's connected channels,
// write the body, and queue it as a pending_approval draft. No brand brief
// required — this is the "I just want to ship one post" path.
export function ComposeForm({ channels }: { channels: ConnectedChannel[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [channel, setChannel] = useState(channels[0]?.channel ?? "");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const maxChars = useMemo(() => channelSpec(channel)?.maxChars ?? 280, [channel]);
  const over = text.length > maxChars;
  const empty = text.trim().length === 0;

  function submit() {
    setError(null);
    start(async () => {
      const r = await createDraftPostAction({ channel, text });
      if (r.error) {
        setError(r.error);
        return;
      }
      // Land back in the queue where the new draft is waiting for approval.
      router.push("/queue");
      router.refresh();
    });
  }

  if (channels.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No channels connected</CardTitle>
          <CardDescription>
            Connect a channel before composing a post — that&apos;s where it&apos;ll publish.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <a href="/settings/channels">Connect a channel</a>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>New post</CardTitle>
        <CardDescription>
          Write one post and drop it into the approval queue — no plan or brand brief needed.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="compose-channel">Channel</Label>
          <select
            id="compose-channel"
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {channels.map((c) => (
              <option key={c.channel} value={c.channel}>
                {c.label} · {c.handle}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="compose-text">Post</Label>
            <span
              className={
                "text-xs tabular-nums " +
                (over ? "text-destructive" : "text-muted-foreground")
              }
            >
              {text.length}/{maxChars}
            </span>
          </div>
          <Textarea
            id="compose-text"
            rows={6}
            value={text}
            maxLength={maxChars}
            placeholder="What do you want to say?"
            onChange={(e) => setText(e.target.value)}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={pending || empty || over} onClick={submit}>
            {pending ? "Adding…" : "Add to queue"}
          </Button>
          <Button variant="ghost" asChild>
            <a href="/queue">Cancel</a>
          </Button>
          {over ? (
            <span className="text-xs text-destructive">
              Exceeds character limit by {text.length - maxChars}
            </span>
          ) : null}
          {error ? <span className="text-xs text-destructive">{error}</span> : null}
        </div>
      </CardContent>
    </Card>
  );
}
