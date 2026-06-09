"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ChannelBadge } from "@/components/ui/badge";
import { displayHandle } from "@/lib/channels/registry";
import { generatePlanAction, type GeneratePlanState } from "./actions";

interface Account {
  id: string;
  channel: string;
  handle: string;
}

const initial: GeneratePlanState = { error: null, planId: null };

interface RowState {
  include: boolean;
  postsPerWeek: number;
  // Plan videos — per-channel opt-in. Only meaningful for video-capable
  // channels when video is available; the submitted `video_<id>="on"` flag
  // drives the kickoff in generatePlanAction.
  video: boolean;
  // UGC avatar video — independent per-channel opt-in. Only meaningful for
  // video-capable channels when UGC is available (Higgsfield key + a saved
  // avatar); the submitted `ugc_<id>="on"` flag drives the UGC kickoff.
  ugc: boolean;
}

// Per-channel sensible default for posts/week. We prefer fewer for
// LinkedIn/Threads (longer copy, lower-cadence platforms) and more for
// X/Bluesky (short-form, higher tolerance for frequency).
const DEFAULTS: Record<string, number> = {
  x: 7,
  bluesky: 7,
  threads: 5,
  linkedin: 3,
  instagram: 3,
};

export function NewPlanForm({
  accounts,
  videoAvailable = false,
  videoCapableAccountIds = [],
  ugcKeyAvailable = false,
  ugcHasAvatar = false,
}: {
  accounts: Account[];
  // True when MPT + BYO encryption are wired up AND this workspace has its own
  // LLM + Pexels keys. When false the per-channel video checkboxes are hidden.
  videoAvailable?: boolean;
  // accountIds whose channel supports video (channelSpec(channel).supportsVideo).
  videoCapableAccountIds?: string[];
  // True when the reference-video feature is enabled AND this workspace has a
  // Higgsfield key on file — the precondition for the UGC opt-in. The per-channel
  // UGC checkbox renders only when this is true AND the workspace has an avatar;
  // when this is true but there's no avatar we show an add-avatar hint instead.
  ugcKeyAvailable?: boolean;
  // True when the workspace has at least one saved avatar to render against.
  ugcHasAvatar?: boolean;
}) {
  const [state, formAction, pending] = useActionState(generatePlanAction, initial);
  const videoCapable = useMemo(
    () => new Set(videoCapableAccountIds),
    [videoCapableAccountIds],
  );
  // UGC reuses the same video-capable channel set (short-form vertical clips),
  // but is only OFFERABLE when the Higgsfield key + a saved avatar are present.
  const ugcAvailable = ugcKeyAvailable && ugcHasAvatar;
  // Default: include the first account, exclude the rest. Users can flip.
  const [rows, setRows] = useState<Record<string, RowState>>(() => {
    const out: Record<string, RowState> = {};
    accounts.forEach((a, i) => {
      out[a.id] = { include: i === 0, postsPerWeek: DEFAULTS[a.channel] ?? 5, video: false, ugc: false };
    });
    return out;
  });

  const anyIncluded = Object.values(rows).some((r) => r.include);
  // When video infra/keys are missing but at least one selected channel COULD
  // take a video, show a single subtle hint linking to the keys page rather than
  // rendering disabled checkboxes everywhere.
  const showVideoKeysHint =
    !videoAvailable &&
    accounts.some((a) => videoCapable.has(a.id) && rows[a.id]?.include);
  // UGC has a key but no avatar yet: a selected video-capable channel COULD take a
  // UGC video, so nudge the user to add an avatar rather than hiding it silently.
  const showUgcAvatarHint =
    ugcKeyAvailable &&
    !ugcHasAvatar &&
    accounts.some((a) => videoCapable.has(a.id) && rows[a.id]?.include);

  return (
    <form action={formAction} className="space-y-8">
      <div className="space-y-3">
        <div className="flex items-end justify-between">
          <div>
            <Label>Channels</Label>
            <p className="text-xs text-muted-foreground">
              Tick the channels to include and pick a per-week cadence for each.
            </p>
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">
            {Object.values(rows).filter((r) => r.include).length}/{accounts.length} on
          </span>
        </div>
        <ul className="divide-y rounded-lg border bg-card">
          {accounts.map((a) => {
            const row = rows[a.id]!;
            // Show the per-channel video checkbox only when video is available
            // AND this channel can take a video. Hidden otherwise (no disabled
            // clutter); the keys hint below covers the "missing keys" case.
            const showVideo = videoAvailable && videoCapable.has(a.id);
            // Same gate as the video checkbox, but for UGC: only when UGC is
            // offerable (key + avatar) AND this channel can take a vertical clip.
            const showUgc = ugcAvailable && videoCapable.has(a.id);
            return (
              <li
                key={a.id}
                className="flex flex-col gap-3 px-4 py-3 transition-colors duration-200 sm:flex-row sm:items-center sm:gap-3"
              >
                <div className="flex flex-1 items-center gap-3">
                  <input
                    type="checkbox"
                    name={`include_${a.id}`}
                    id={`include_${a.id}`}
                    checked={row.include}
                    onChange={(e) =>
                      setRows((r) => ({ ...r, [a.id]: { ...r[a.id]!, include: e.target.checked } }))
                    }
                    className="h-4 w-4 shrink-0 rounded border-input transition-colors duration-200"
                  />
                  <Label
                    htmlFor={`include_${a.id}`}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5"
                  >
                    <ChannelBadge channel={a.channel} />
                    <span className="truncate text-sm">{displayHandle(a.handle)}</span>
                  </Label>
                </div>
                <div className="flex flex-col items-stretch gap-2 self-stretch sm:flex-row sm:items-center sm:gap-3 sm:self-auto">
                  {showVideo ? (
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        name={`video_${a.id}`}
                        id={`video_${a.id}`}
                        checked={row.video}
                        disabled={!row.include}
                        onChange={(e) =>
                          setRows((r) => ({ ...r, [a.id]: { ...r[a.id]!, video: e.target.checked } }))
                        }
                        className="h-4 w-4 shrink-0 rounded border-input transition-colors duration-200"
                      />
                      <Label
                        htmlFor={`video_${a.id}`}
                        className="cursor-pointer text-xs text-muted-foreground"
                      >
                        Generate a short video for each post
                      </Label>
                    </div>
                  ) : null}
                  {showUgc ? (
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        name={`ugc_${a.id}`}
                        id={`ugc_${a.id}`}
                        checked={row.ugc}
                        disabled={!row.include}
                        onChange={(e) =>
                          setRows((r) => ({ ...r, [a.id]: { ...r[a.id]!, ugc: e.target.checked } }))
                        }
                        className="h-4 w-4 shrink-0 rounded border-input transition-colors duration-200"
                      />
                      <Label
                        htmlFor={`ugc_${a.id}`}
                        className="cursor-pointer text-xs text-muted-foreground"
                      >
                        Generate UGC avatar video
                      </Label>
                    </div>
                  ) : null}
                  <div className="flex items-center gap-2 self-end sm:self-auto">
                    <span className="text-xs text-muted-foreground">posts/week</span>
                    <Input
                      type="number"
                      name={`posts_${a.id}`}
                      min={1}
                      max={28}
                      value={row.postsPerWeek}
                      onChange={(e) =>
                        setRows((r) => ({
                          ...r,
                          [a.id]: { ...r[a.id]!, postsPerWeek: Number(e.target.value) || 1 },
                        }))
                      }
                      disabled={!row.include}
                      className="h-9 w-20 text-sm tabular-nums"
                    />
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
        {!anyIncluded ? (
          <p className="text-xs text-destructive">Pick at least one channel to generate a plan.</p>
        ) : null}
        {showVideoKeysHint ? (
          <p className="text-xs text-muted-foreground">
            Want a short video on each post?{" "}
            <Link className="font-medium underline underline-offset-4" href="/settings/video-keys">
              Add your video keys
            </Link>{" "}
            to enable.
          </p>
        ) : null}
        {showUgcAvatarHint ? (
          <p className="text-xs text-muted-foreground">
            Want a UGC avatar video on each post?{" "}
            <Link className="font-medium underline underline-offset-4" href="/settings/avatars">
              Add an avatar
            </Link>{" "}
            to enable.
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="weeks">Weeks</Label>
        <Input id="weeks" name="weeks" type="number" defaultValue={1} min={1} max={4} required className="w-32" />
        <p className="text-xs text-muted-foreground">
          Claude reads your brief, splits the cadence across channels, and lands every draft in the queue.
        </p>
      </div>

      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          name="compare_competitors"
          id="compare_competitors"
          value="1"
          className="mt-0.5 h-4 w-4 shrink-0 rounded border-input transition-colors duration-200"
        />
        <Label htmlFor="compare_competitors" className="cursor-pointer">
          <span className="block">Compare what competitors are doing</span>
          <span className="block text-xs font-normal text-muted-foreground">
            Analyze top performers on each channel and incorporate what&apos;s working.
          </span>
        </Label>
      </div>

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.planId ? (
        <p className="text-sm text-emerald-600 dark:text-emerald-400">
          Plan generated. Redirecting…
        </p>
      ) : null}

      <Button type="submit" disabled={pending || !anyIncluded} className="w-full">
        {pending ? "Drafting your plan (≈30s)…" : "Generate plan"}
      </Button>
    </form>
  );
}
