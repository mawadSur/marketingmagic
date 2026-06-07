"use client";

import * as React from "react";
import { useFormState, useFormStatus } from "react-dom";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { transcribeRecordingAction } from "./actions";
import type { JargonHint } from "@/lib/sources/transcribe";
import {
  generateFromVoiceMemoAction,
  type GenerateFromVoiceMemoState,
} from "./generate-action";

// Recording UI for /record. Mobile-first by design — the record button is
// the dominant surface, everything else is secondary copy. We keep the
// MediaRecorder pipeline simple:
//
//   idle → recording → stopped → transcribing → ready
//                              ↘ error (retry returns to idle)
//
// The transcribed text is held in client state and rendered in an
// editable textarea so the user can fix mis-heard product names / jargon
// before generation. Low-confidence Whisper segments are highlighted with
// `<mark>` until the user makes their first edit (see EditableTranscript
// for why the marks are dismissed on edit). The "Generate week of posts"
// button submits the edited transcript to generateFromVoiceMemoAction.

type Status =
  | "permission"
  | "idle"
  | "recording"
  | "stopped"
  | "transcribing"
  | "ready"
  | "error";

interface Props {
  keepRawAudio: boolean;
  transcriptionConfigured: boolean;
}

export function RecordClient({ keepRawAudio, transcriptionConfigured }: Props) {
  const [status, setStatus] = React.useState<Status>("idle");
  const [transcript, setTranscript] = React.useState<string>("");
  // Phase 2.6/2: we keep the raw Whisper output around so the jargon-hint
  // overlay can decide whether to show itself. The overlay only renders
  // when `transcript === initialTranscript` (the user hasn't edited yet —
  // hint character offsets become stale on the first keystroke). Once the
  // user types, the marks vanish and the textarea is plain text.
  const [initialTranscript, setInitialTranscript] = React.useState<string>("");
  const [hints, setHints] = React.useState<JargonHint[]>([]);
  const [errorMessage, setErrorMessage] = React.useState<string>("");
  const [elapsedSec, setElapsedSec] = React.useState<number>(0);
  const [audioStoragePath, setAudioStoragePath] = React.useState<string | null>(null);

  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const streamRef = React.useRef<MediaStream | null>(null);
  const timerRef = React.useRef<number | null>(null);

  // Pick the best MIME the browser supports. Chromium gives webm/opus;
  // Safari only gives mp4/m4a. MediaRecorder.isTypeSupported gates this so
  // we don't try to record into an unsupported container.
  const preferredMimeType = React.useMemo(() => {
    if (typeof window === "undefined") return "";
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4;codecs=mp4a.40.2",
      "audio/mp4",
    ];
    for (const m of candidates) {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) {
        return m;
      }
    }
    return "";
  }, []);

  // Cleanup mic + timer on unmount. Important: hot-reloading the route in
  // dev without this leaves the mic indicator stuck on in browsers.
  React.useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, []);

  async function startRecording() {
    setErrorMessage("");
    setTranscript("");
    setInitialTranscript("");
    setHints([]);
    setAudioStoragePath(null);
    setStatus("permission");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const options: MediaRecorderOptions = preferredMimeType
        ? { mimeType: preferredMimeType }
        : {};
      const recorder = new MediaRecorder(stream, options);
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        if (timerRef.current) {
          window.clearInterval(timerRef.current);
          timerRef.current = null;
        }
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;

        const blob = new Blob(chunksRef.current, {
          type: preferredMimeType || "audio/webm",
        });
        chunksRef.current = [];
        await sendToServer(blob);
      };

      // 1-second chunks. Lets us flush even if the page is suspended
      // mid-recording — Safari has been known to drop the final blob on
      // background-tab transitions.
      recorder.start(1000);
      setElapsedSec(0);
      const startedAt = Date.now();
      timerRef.current = window.setInterval(() => {
        setElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
      }, 250);
      setStatus("recording");
    } catch (err) {
      setStatus("error");
      setErrorMessage(
        err instanceof Error
          ? `Mic access denied: ${err.message}`
          : "Mic access denied.",
      );
    }
  }

  function stopRecording() {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      setStatus("stopped");
      recorderRef.current.stop();
    }
  }

  async function sendToServer(blob: Blob) {
    setStatus("transcribing");
    try {
      const fd = new FormData();
      fd.append("audio", blob, `recording.${blob.type.includes("mp4") ? "m4a" : "webm"}`);
      const res = await transcribeRecordingAction(fd);
      if (!res.ok || !res.transcript) {
        setStatus("error");
        setErrorMessage(res.error ?? "Transcription failed.");
        return;
      }
      setTranscript(res.transcript);
      setInitialTranscript(res.transcript);
      setHints(res.hints ?? []);
      setAudioStoragePath(res.audioStoragePath ?? null);
      setStatus("ready");
    } catch (err) {
      setStatus("error");
      setErrorMessage(err instanceof Error ? err.message : "Network error.");
    }
  }

  function reset() {
    setStatus("idle");
    setErrorMessage("");
    setTranscript("");
    setInitialTranscript("");
    setHints([]);
    setElapsedSec(0);
    setAudioStoragePath(null);
  }

  return (
    <div className="mx-auto flex min-h-[calc(100vh-12rem)] max-w-xl flex-col gap-6 py-4">
      <header className="space-y-1 text-center sm:text-left">
        <p className="label-eyebrow">Founder Mode</p>
        <h1 className="text-2xl font-semibold tracking-tight">Voice memo</h1>
        <p className="text-sm text-muted-foreground">
          Talk for as long as you want. We'll transcribe it and turn it into a
          week of posts on the next screen.
        </p>
      </header>

      {!transcriptionConfigured ? (
        <ConfigurationWarning />
      ) : null}

      <RecordSurface
        status={status}
        elapsedSec={elapsedSec}
        onStart={startRecording}
        onStop={stopRecording}
      />

      <RetentionFootnote keepRawAudio={keepRawAudio} />

      {status === "ready" && transcript ? (
        <TranscriptPreview
          transcript={transcript}
          initialTranscript={initialTranscript}
          hints={hints}
          audioStoragePath={audioStoragePath}
          onTranscriptChange={setTranscript}
          onRecordAgain={reset}
        />
      ) : null}

      {status === "error" && errorMessage ? (
        <ErrorBlock message={errorMessage} onRetry={reset} />
      ) : null}
    </div>
  );
}

function RecordSurface({
  status,
  elapsedSec,
  onStart,
  onStop,
}: {
  status: Status;
  elapsedSec: number;
  onStart: () => void;
  onStop: () => void;
}) {
  const isRecording = status === "recording";
  const isWorking = status === "permission" || status === "stopped" || status === "transcribing";
  const label =
    status === "permission"
      ? "Asking for the mic…"
      : status === "recording"
        ? formatElapsed(elapsedSec)
        : status === "stopped"
          ? "Wrapping up…"
          : status === "transcribing"
            ? "Transcribing…"
            : status === "ready"
              ? "Done — record again?"
              : "Tap to record";

  return (
    <div className="flex flex-col items-center gap-4 rounded-2xl border bg-card p-8 shadow-sm">
      <button
        type="button"
        onClick={isRecording ? onStop : onStart}
        disabled={isWorking}
        aria-pressed={isRecording}
        aria-label={isRecording ? "Stop recording" : "Start recording"}
        className={[
          "relative flex h-32 w-32 items-center justify-center rounded-full text-base font-semibold transition-all",
          "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/30",
          "disabled:cursor-not-allowed disabled:opacity-60",
          isRecording
            ? "bg-red-500 text-white animate-pulse shadow-[0_0_0_8px_rgba(239,68,68,0.15)]"
            : "bg-primary text-primary-foreground hover:scale-[1.02]",
        ].join(" ")}
      >
        {isRecording ? (
          <span className="block h-8 w-8 rounded-sm bg-white" aria-hidden />
        ) : (
          <span className="block h-10 w-10 rounded-full bg-current opacity-90" aria-hidden />
        )}
      </button>
      <p
        aria-live="polite"
        className="text-sm tabular-nums text-muted-foreground"
      >
        {label}
      </p>
    </div>
  );
}

function TranscriptPreview({
  transcript,
  initialTranscript,
  hints,
  audioStoragePath,
  onTranscriptChange,
  onRecordAgain,
}: {
  transcript: string;
  initialTranscript: string;
  hints: JargonHint[];
  audioStoragePath: string | null;
  onTranscriptChange: (next: string) => void;
  onRecordAgain: () => void;
}) {
  const initialState: GenerateFromVoiceMemoState = { error: null, planId: null };
  const [genState, formAction] = useFormState(generateFromVoiceMemoAction, initialState);

  // Jargon-hint overlay only renders while the textarea matches the
  // initial Whisper output — character offsets shift the moment the user
  // edits. After that the marks vanish and the textarea is plain text.
  const showHints = transcript === initialTranscript && hints.length > 0;
  const helpCopy = showHints
    ? "Highlighted words were low-confidence in Whisper. Tap to fix."
    : "Tap to edit — fix product names or jargon before we generate posts.";

  return (
    <section className="space-y-3 rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">Transcript</h2>
        <span className="text-xs text-muted-foreground">
          {audioStoragePath ? "Audio saved." : "Audio discarded."}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{helpCopy}</p>
      <EditableTranscript
        value={transcript}
        initialValue={initialTranscript}
        hints={hints}
        showHints={showHints}
        onChange={onTranscriptChange}
      />
      {/* Hidden form so the (possibly-edited) transcript posts to the
          server action; useFormState surfaces errors without a useEffect. */}
      <form action={formAction} className="space-y-2">
        <input type="hidden" name="text" value={transcript} />
        <input type="hidden" name="audioStoragePath" value={audioStoragePath ?? ""} />
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" type="button" onClick={onRecordAgain}>
            Record again
          </Button>
          <GenerateButton />
        </div>
        {genState.error ? (
          <p className="text-xs text-destructive">{genState.error}</p>
        ) : null}
      </form>
    </section>
  );
}

// Editable transcript with optional jargon-hint overlay. The overlay is
// an absolute-positioned `<div>` behind a transparent-text textarea —
// same font + line-height + padding so the `<mark>` spans line up with
// the textarea's words. Granola-style: once the user edits, the marks
// vanish (offsets become stale) and we don't try to re-compute them.
function EditableTranscript({
  value,
  initialValue,
  hints,
  showHints,
  onChange,
}: {
  value: string;
  initialValue: string;
  hints: JargonHint[];
  showHints: boolean;
  onChange: (next: string) => void;
}) {
  return (
    <div className="relative">
      {showHints ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-transparent p-3 text-sm leading-relaxed text-transparent"
        >
          {renderHintedText(initialValue, hints)}
        </div>
      ) : null}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={8}
        className={[
          "relative block max-h-72 w-full overflow-auto whitespace-pre-wrap break-words rounded-md border bg-background p-3 text-sm leading-relaxed",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
          showHints ? "text-transparent caret-foreground" : "",
        ].join(" ")}
        spellCheck
        aria-label="Edit transcript"
      />
    </div>
  );
}

// Render the transcript text with `<mark>` spans wrapping each hinted
// word. Hints are pre-sorted by start offset in the server action — we
// belt-and-braces re-sort here in case a future caller hands them in
// unordered. Overlapping hints are coalesced by taking the earliest
// start to the latest end.
function renderHintedText(text: string, hints: JargonHint[]): React.ReactNode[] {
  if (hints.length === 0) return [text];
  const sorted = [...hints].sort((a, b) => a.start - b.start);
  const merged: JargonHint[] = [];
  for (const h of sorted) {
    const last = merged[merged.length - 1];
    if (last && h.start <= last.end) {
      last.end = Math.max(last.end, h.end);
    } else {
      merged.push({ ...h });
    }
  }
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (let i = 0; i < merged.length; i++) {
    const h = merged[i];
    if (h.start > cursor) nodes.push(text.slice(cursor, h.start));
    nodes.push(
      <mark
        key={`hint-${i}`}
        title="Whisper wasn't sure about this word — tap to edit."
        className="rounded-sm bg-amber-400/30 text-foreground decoration-amber-500 underline decoration-dotted underline-offset-2"
      >
        {text.slice(h.start, h.end)}
      </mark>,
    );
    cursor = h.end;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function GenerateButton() {
  const { pending } = useFormStatus();
  return (
    <Button size="sm" type="submit" disabled={pending}>
      {pending ? "Generating…" : "Generate week of posts"}
    </Button>
  );
}

function RetentionFootnote({ keepRawAudio }: { keepRawAudio: boolean }) {
  return (
    <p className="text-center text-xs text-muted-foreground sm:text-left">
      {keepRawAudio ? (
        <>
          Audio retention is <span className="font-medium">on</span> — your
          recording is saved to your private vault for 30 days.{" "}
          <Link href="/settings/brief" className="underline">
            Change
          </Link>
        </>
      ) : (
        <>
          Audio is <span className="font-medium">discarded</span> after
          transcription. Only the transcript is saved.{" "}
          <Link href="/settings/brief" className="underline">
            Change
          </Link>
        </>
      )}
    </p>
  );
}

function ConfigurationWarning() {
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-900 dark:text-amber-200">
      Voice transcription isn't configured for this environment. Ask the
      operator to set <code className="font-mono">GROQ_API_KEY</code>.
    </div>
  );
}

function ErrorBlock({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="space-y-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
      <p className="font-medium">Something went wrong.</p>
      <p className="text-muted-foreground">{message}</p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
