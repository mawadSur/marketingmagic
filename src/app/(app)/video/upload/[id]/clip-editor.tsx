"use client";

// Clip editor (slice E) — the interactive heart of user-video-upload.
//
// A native <video> player + a lightweight timeline where the user marks MULTIPLE
// in/out ranges, labels each, toggles burn-captions per clip, then submits the
// whole batch to the slice-D clip orchestrator (via createClipsAction). The
// transcript panel sits beside it (click-to-seek + "clip from this line").
//
// Timeline is plain React driven off the <video> element's currentTime/duration
// — no heavy waveform/timeline dependency. All range math lives in the pure,
// unit-tested clip-math.ts so this file stays presentational.

import { useActionState, useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { TranscriptSegment } from "@/lib/video/uploads/types";
import { TranscriptPanel } from "./transcript-panel";
import { createClipsAction, type CreateClipsState } from "./clip-actions";
import {
  type DraftClip,
  clampMs,
  clipDurationMs,
  draftsToSpecs,
  formatClock,
  isValidRange,
  MIN_CLIP_MS,
} from "./clip-math";

const SELECT_CLASS =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

const initialState: CreateClipsState = { error: null, success: null, quota: false };

let draftSeq = 0;
function newDraftId(): string {
  draftSeq += 1;
  return `d${draftSeq}-${Math.random().toString(36).slice(2, 7)}`;
}

export interface ClipEditorProps {
  uploadedVideoId: string;
  // Signed GET URL to the private source-video object (minted server-side).
  sourceUrl: string;
  // Source length in ms, from probe metadata. 0 = unknown (we read it off the
  // <video> element once metadata loads).
  durationMs: number;
  aspectGuess?: "9:16" | "16:9" | "1:1";
  segments: TranscriptSegment[];
  transcriptPending?: boolean;
}

export function ClipEditor({
  uploadedVideoId,
  sourceUrl,
  durationMs,
  aspectGuess = "9:16",
  segments,
  transcriptPending = false,
}: ClipEditorProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [state, action, pending] = useActionState(createClipsAction, initialState);

  // Live playhead + duration. We seed duration from probe metadata but trust the
  // element once it loads (the element is authoritative for seeking).
  const [currentMs, setCurrentMs] = useState(0);
  const [loadedMs, setLoadedMs] = useState(durationMs);
  const effectiveDuration = loadedMs > 0 ? loadedMs : durationMs;

  const [drafts, setDrafts] = useState<DraftClip[]>([]);
  const [aspect, setAspect] = useState<"9:16" | "16:9" | "1:1">(aspectGuess);

  // ── player wiring ───────────────────────────────────────────────
  const seek = useCallback((ms: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, ms / 1000);
    setCurrentMs(ms);
  }, []);

  const onTimeUpdate = useCallback(() => {
    const v = videoRef.current;
    if (v) setCurrentMs(Math.round(v.currentTime * 1000));
  }, []);

  const onLoadedMetadata = useCallback(() => {
    const v = videoRef.current;
    if (v && Number.isFinite(v.duration) && v.duration > 0) {
      setLoadedMs(Math.round(v.duration * 1000));
    }
  }, []);

  // ── clip CRUD ───────────────────────────────────────────────────
  const addDraft = useCallback(
    (startMs: number, endMs: number) => {
      setDrafts((prev) => [
        ...prev,
        {
          id: newDraftId(),
          label: `Clip ${prev.length + 1}`,
          startMs,
          endMs,
          burnCaptions: segments.length > 0,
        },
      ]);
    },
    [segments.length],
  );

  // Start a new clip at the current playhead (default ~10s long, clamped).
  const addAtPlayhead = useCallback(() => {
    const start = clampMs(currentMs, effectiveDuration);
    const end = clampMs(start + 10_000, effectiveDuration || start + 10_000);
    addDraft(start, end > start ? end : start + MIN_CLIP_MS);
  }, [currentMs, effectiveDuration, addDraft]);

  const setMark = useCallback(
    (id: string, edge: "startMs" | "endMs") => {
      const here = clampMs(currentMs, effectiveDuration || currentMs);
      setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, [edge]: here } : d)));
    },
    [currentMs, effectiveDuration],
  );

  const updateDraft = useCallback((id: string, patch: Partial<DraftClip>) => {
    setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  }, []);

  const removeDraft = useCallback((id: string) => {
    setDrafts((prev) => prev.filter((d) => d.id !== id));
  }, []);

  // ── submit payload ──────────────────────────────────────────────
  const specs = useMemo(() => draftsToSpecs(drafts, effectiveDuration), [drafts, effectiveDuration]);
  const payload = useMemo(
    () => JSON.stringify({ uploadedVideoId, aspect, clips: specs }),
    [uploadedVideoId, aspect, specs],
  );
  const canSubmit = specs.length > 0 && !pending;

  const hasTranscript = segments.length > 0;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      {/* ── left: player + timeline + clip list ── */}
      <div className="space-y-5">
        <div className="overflow-hidden rounded-xl border bg-black">
          <video
            ref={videoRef}
            src={sourceUrl}
            controls
            playsInline
            preload="metadata"
            onTimeUpdate={onTimeUpdate}
            onLoadedMetadata={onLoadedMetadata}
            className="mx-auto max-h-[26rem] w-auto"
          />
        </div>

        {/* Timeline scrubber with clip-range overlays. */}
        <Timeline
          durationMs={effectiveDuration}
          currentMs={currentMs}
          drafts={drafts}
          onScrub={seek}
        />

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={addAtPlayhead}>
            + Add clip at {formatClock(currentMs)}
          </Button>
          <span className="text-xs text-muted-foreground">
            Play the video, then mark where each clip starts and ends.
          </span>
        </div>

        {/* Editable list of marked clips. */}
        {drafts.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No clips marked yet. Scrub to a moment and press “Add clip”, or use “+ Clip” on a
            transcript line.
          </p>
        ) : (
          <ul className="space-y-3">
            {drafts.map((d, i) => {
              const valid = isValidRange(d, effectiveDuration);
              return (
                <li key={d.id} className="space-y-2 rounded-lg border p-3">
                  <div className="flex items-center gap-2">
                    <Input
                      value={d.label}
                      onChange={(e) => updateDraft(d.id, { label: e.target.value })}
                      maxLength={64}
                      aria-label={`Clip ${i + 1} name`}
                      className="h-9 flex-1"
                    />
                    <button
                      type="button"
                      onClick={() => removeDraft(d.id)}
                      className="shrink-0 rounded-md border px-2 py-1.5 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    >
                      Remove
                    </button>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <button
                      type="button"
                      onClick={() => seek(d.startMs)}
                      className="rounded border px-2 py-1 font-mono tabular-nums hover:bg-muted"
                      title="Jump to clip start"
                    >
                      ▶ {formatClock(d.startMs)}
                    </button>
                    <button
                      type="button"
                      onClick={() => setMark(d.id, "startMs")}
                      className="rounded border px-2 py-1 hover:bg-muted"
                    >
                      Set in
                    </button>
                    <span className="text-muted-foreground">→</span>
                    <button
                      type="button"
                      onClick={() => seek(d.endMs)}
                      className="rounded border px-2 py-1 font-mono tabular-nums hover:bg-muted"
                      title="Jump to clip end"
                    >
                      ▶ {formatClock(d.endMs)}
                    </button>
                    <button
                      type="button"
                      onClick={() => setMark(d.id, "endMs")}
                      className="rounded border px-2 py-1 hover:bg-muted"
                    >
                      Set out
                    </button>
                    <span className="text-muted-foreground tabular-nums">
                      ({formatClock(clipDurationMs(d))})
                    </span>
                    {!valid ? (
                      <span className="text-destructive">Range too short or out of bounds</span>
                    ) : null}
                  </div>

                  <label
                    className={
                      "flex items-center gap-2 text-xs " +
                      (hasTranscript ? "" : "cursor-not-allowed text-muted-foreground")
                    }
                  >
                    <input
                      type="checkbox"
                      checked={d.burnCaptions && hasTranscript}
                      disabled={!hasTranscript}
                      onChange={(e) => updateDraft(d.id, { burnCaptions: e.target.checked })}
                    />
                    Burn captions into this clip
                    {!hasTranscript ? " (transcribe the video first)" : ""}
                  </label>
                </li>
              );
            })}
          </ul>
        )}

        {/* Submit. payload + aspect ride as hidden fields on the action form. */}
        <form action={action} className="space-y-3 border-t pt-4">
          <input type="hidden" name="payload" value={payload} />
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="clipAspect">Output aspect</Label>
              <select
                id="clipAspect"
                value={aspect}
                onChange={(e) => setAspect(e.target.value as typeof aspect)}
                className={SELECT_CLASS + " w-56"}
              >
                <option value="9:16">9:16 — Vertical (Reels, Shorts, TikTok)</option>
                <option value="16:9">16:9 — Landscape (YouTube)</option>
                <option value="1:1">1:1 — Square (feed)</option>
              </select>
            </div>
            <Button type="submit" disabled={!canSubmit}>
              {pending
                ? "Starting…"
                : specs.length > 0
                  ? `Create ${specs.length} clip${specs.length === 1 ? "" : "s"}`
                  : "Create clips"}
            </Button>
          </div>

          {state.error ? (
            <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
              <p className="text-destructive">{state.error}</p>
              {state.quota ? (
                <Link href="/settings/billing" className="font-medium underline underline-offset-4">
                  Upgrade your plan →
                </Link>
              ) : null}
            </div>
          ) : null}
          {state.success ? <p className="text-sm text-emerald-600">{state.success}</p> : null}
        </form>
      </div>

      {/* ── right: transcript ── */}
      <aside className="space-y-2">
        <h2 className="text-sm font-semibold">Transcript</h2>
        <TranscriptPanel
          segments={segments}
          currentMs={currentMs}
          onSeek={seek}
          onClipFrom={(s, e) => addDraft(s, e)}
          pending={transcriptPending}
        />
      </aside>
    </div>
  );
}

// Minimal timeline scrubber: a clickable track that shows the playhead and a
// shaded band for each marked clip. Click anywhere to seek there.
function Timeline({
  durationMs,
  currentMs,
  drafts,
  onScrub,
}: {
  durationMs: number;
  currentMs: number;
  drafts: DraftClip[];
  onScrub: (ms: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dur = durationMs > 0 ? durationMs : 0;

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const el = trackRef.current;
      if (!el || dur <= 0) return;
      const rect = el.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      onScrub(Math.round(Math.max(0, Math.min(1, ratio)) * dur));
    },
    [dur, onScrub],
  );

  const pct = (ms: number) => (dur > 0 ? Math.max(0, Math.min(100, (ms / dur) * 100)) : 0);

  return (
    <div className="space-y-1">
      <div
        ref={trackRef}
        onClick={handleClick}
        role="slider"
        aria-label="Timeline"
        aria-valuemin={0}
        aria-valuemax={Math.round(dur)}
        aria-valuenow={Math.round(currentMs)}
        tabIndex={0}
        className="relative h-8 cursor-pointer overflow-hidden rounded-md border bg-muted/40"
      >
        {drafts.map((d) => (
          <div
            key={d.id}
            className="absolute inset-y-0 bg-primary/20"
            style={{ left: `${pct(d.startMs)}%`, width: `${Math.max(0.5, pct(d.endMs) - pct(d.startMs))}%` }}
          />
        ))}
        {/* Playhead */}
        <div
          className="absolute inset-y-0 w-0.5 bg-primary"
          style={{ left: `${pct(currentMs)}%` }}
        />
      </div>
      <div className="flex justify-between text-[11px] tabular-nums text-muted-foreground">
        <span>0:00</span>
        <span>{formatClock(dur)}</span>
      </div>
    </div>
  );
}
