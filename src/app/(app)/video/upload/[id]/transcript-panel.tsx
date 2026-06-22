"use client";

// Transcript panel for the clip editor (slice E, owned here).
//
// Renders the source video's transcript beside the timeline. Each segment is
// click-to-seek (jumps the shared <video> via the onSeek callback) and offers a
// "Clip from here" affordance so the user can turn a spoken sentence straight
// into a clip range. Editing the transcript TEXT and persisting it is slice-B's
// concern (transcript-actions.ts) — this component is the read/seek surface and
// stays presentational so it composes cleanly into the editor.

import { useMemo, useState } from "react";
import type { TranscriptSegment } from "@/lib/video/uploads/types";
import { formatClock } from "./clip-math";

export interface TranscriptPanelProps {
  segments: TranscriptSegment[];
  // Current playhead in ms, so the active cue can highlight as the video plays.
  currentMs: number;
  // Seek the shared player to this ms offset.
  onSeek: (ms: number) => void;
  // Pre-fill a new clip range from a transcript segment (start/end in ms).
  onClipFrom: (startMs: number, endMs: number) => void;
  // Optional: not-yet-transcribed state (slice-B owns kicking off transcription).
  pending?: boolean;
}

export function TranscriptPanel({
  segments,
  currentMs,
  onSeek,
  onClipFrom,
  pending = false,
}: TranscriptPanelProps) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return segments;
    return segments.filter((s) => s.text.toLowerCase().includes(q));
  }, [segments, query]);

  // Index of the cue under the playhead, for the highlight.
  const activeIdx = useMemo(() => {
    for (let i = 0; i < segments.length; i += 1) {
      if (currentMs >= segments[i].startMs && currentMs < segments[i].endMs) return i;
    }
    return -1;
  }, [segments, currentMs]);

  if (pending) {
    return (
      <div className="rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground">
        Transcribing your video… the transcript will appear here in a moment.
      </div>
    );
  }

  if (segments.length === 0) {
    return (
      <div className="rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground">
        No transcript yet for this video.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col rounded-lg border">
      <div className="border-b p-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search transcript…"
          className="h-8 w-full rounded-md border border-input bg-background px-2.5 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        />
      </div>
      <ul className="max-h-[28rem] divide-y overflow-y-auto text-sm">
        {filtered.map((seg) => {
          const realIdx = segments.indexOf(seg);
          const active = realIdx === activeIdx;
          return (
            <li
              key={`${seg.startMs}-${seg.endMs}-${realIdx}`}
              className={
                "group flex gap-2 p-2.5 transition-colors " +
                (active ? "bg-primary/5" : "hover:bg-muted/40")
              }
            >
              <button
                type="button"
                onClick={() => onSeek(seg.startMs)}
                className="shrink-0 pt-0.5 font-mono text-[11px] tabular-nums text-primary underline-offset-2 hover:underline"
                title="Jump to this moment"
              >
                {formatClock(seg.startMs)}
              </button>
              <p className="min-w-0 flex-1 text-foreground/90">{seg.text}</p>
              <button
                type="button"
                onClick={() => onClipFrom(seg.startMs, seg.endMs)}
                className="shrink-0 self-start rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
                title="Start a clip from this line"
              >
                + Clip
              </button>
            </li>
          );
        })}
        {filtered.length === 0 ? (
          <li className="p-3 text-center text-xs text-muted-foreground">No lines match “{query}”.</li>
        ) : null}
      </ul>
    </div>
  );
}
