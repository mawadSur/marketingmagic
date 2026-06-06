"use client";

import { useTransition, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  setAutoReplyEnabledAction,
  setAutoReplyKillSwitchAction,
} from "./actions";

// Bet 4 — per-account auto-reply opt-in + the workspace kill-switch surface.
//
// Auto-reply is the riskiest thing this product does autonomously: it sends
// public replies at named people with no human in the loop. The UI reflects
// that: it's only offered once trust mode is on, the copy is explicit about
// what will happen, and the workspace-wide kill switch is always one click
// away even when the per-account opt-in is on.
export function AutoReplyToggle({
  accountId,
  channel,
  trustMode,
  autoReplyEnabled,
  supported,
  killSwitchEngaged,
}: {
  accountId: string;
  channel: string;
  trustMode: boolean;
  autoReplyEnabled: boolean;
  supported: boolean;
  killSwitchEngaged: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function flip(enable: boolean) {
    start(async () => {
      const r = await setAutoReplyEnabledAction(accountId, enable);
      if (r.error) setError(r.error);
      else {
        setError(null);
        router.refresh();
      }
    });
  }

  function flipKillSwitch(kill: boolean) {
    start(async () => {
      const r = await setAutoReplyKillSwitchAction(kill);
      if (r.error) setError(r.error);
      else {
        setError(null);
        router.refresh();
      }
    });
  }

  if (!supported) {
    return (
      <div className="space-y-2 rounded-lg border p-4">
        <p className="text-sm font-medium">Autonomous auto-reply</p>
        <p className="text-xs text-muted-foreground">
          Not available on {channel}. Auto-reply ships on X, Bluesky, and
          LinkedIn only.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
      <p className="text-sm font-medium">
        Autonomous auto-reply: {autoReplyEnabled ? "on" : "off"}
      </p>
      <p className="text-xs text-muted-foreground">
        When on, incoming mentions/comments on this channel get an on-brand
        reply drafted <em>and sent automatically</em> — no review step. Off by
        default. Rate-limited to avoid platform spam enforcement. Requires trust
        mode. The kill switch below stops everything instantly.
      </p>

      {killSwitchEngaged ? (
        <p className="text-xs font-medium text-destructive">
          Kill switch engaged — auto-reply is paused for the whole workspace.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {autoReplyEnabled ? (
          <Button variant="destructive" disabled={pending} onClick={() => flip(false)}>
            Turn off auto-reply
          </Button>
        ) : (
          <Button disabled={!trustMode || pending} onClick={() => flip(true)}>
            Turn on auto-reply
          </Button>
        )}
        {!trustMode && !autoReplyEnabled ? (
          <span className="text-xs text-muted-foreground">
            Turn on trust mode first.
          </span>
        ) : null}
      </div>

      <div className="border-t pt-3">
        <p className="text-xs font-medium">Workspace kill switch</p>
        <p className="text-xs text-muted-foreground">
          Hard stop for ALL auto-replies across every channel in this workspace.
        </p>
        <div className="mt-2">
          {killSwitchEngaged ? (
            <Button variant="outline" disabled={pending} onClick={() => flipKillSwitch(false)}>
              Resume auto-replies
            </Button>
          ) : (
            <Button variant="destructive" disabled={pending} onClick={() => flipKillSwitch(true)}>
              Stop all auto-replies now
            </Button>
          )}
        </div>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
