"use client";

import { useTransition, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import type { EngagementMode } from "@/lib/db/types";
import {
  setAutoReplyModeAction,
  setAutoReplyKillSwitchAction,
} from "./actions";

// Bet 4 — per-account auto-reply MODE (tri-state) + the workspace kill switch.
//
// Auto-reply is the riskiest thing this product does autonomously: in 'live'
// it sends public replies at named people with no human in the loop. SHADOW is
// the safe middle state — it drafts exactly what it WOULD reply and logs it for
// review, but never posts. The UI reflects that: it's only offered once trust
// mode is on, each mode is explicit about what happens, and the workspace-wide
// kill switch is always one click away.
const MODE_COPY: Record<EngagementMode, string> = {
  off: "Does nothing on this channel.",
  shadow:
    "Drafts what it WOULD reply and logs it for you to review — but never posts and never marks the item handled. Zero public blast radius. Start here.",
  live: "Drafts AND sends on-brand replies automatically — no review step.",
};

export function AutoReplyToggle({
  accountId,
  channel,
  trustMode,
  mode,
  supported,
  killSwitchEngaged,
}: {
  accountId: string;
  channel: string;
  trustMode: boolean;
  mode: EngagementMode;
  supported: boolean;
  killSwitchEngaged: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function setMode(next: EngagementMode) {
    if (next === mode) return;
    start(async () => {
      const r = await setAutoReplyModeAction(accountId, next);
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

  const modes: EngagementMode[] = ["off", "shadow", "live"];

  return (
    <div className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
      <p className="text-sm font-medium">Autonomous auto-reply: {mode}</p>
      <p className="text-xs text-muted-foreground">
        Choose how this channel handles incoming mentions/comments. Off by
        default; <em>shadow</em> is the safe way to preview before going live.
        Rate-limited to avoid platform spam enforcement. Engaging requires trust
        mode. The kill switch below stops everything instantly.
      </p>

      {killSwitchEngaged ? (
        <p className="text-xs font-medium text-destructive">
          Kill switch engaged — auto-reply is paused for the whole workspace.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {modes.map((m) => {
          // 'off' always allowed. 'shadow' sends nothing (zero blast radius), so
          // it's reachable without trust — preview before you've earned it.
          // 'live' actually posts, so it still requires the publishing trust bar.
          const gated = m === "live" && !trustMode;
          const active = m === mode;
          return (
            <Button
              key={m}
              variant={active ? "default" : "outline"}
              disabled={pending || gated || active}
              onClick={() => setMode(m)}
            >
              {active ? `✓ ${m}` : m}
            </Button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">{MODE_COPY[mode]}</p>
      {!trustMode ? (
        <span className="text-xs text-muted-foreground">
          Shadow works now (it previews without sending). Going <em>live</em>{" "}
          requires trust mode.
        </span>
      ) : null}

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
