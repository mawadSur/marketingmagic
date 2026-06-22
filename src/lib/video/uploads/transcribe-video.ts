// Slice B — transcription for user-uploaded source videos (migration 068).
//
// `transcribeUploadedVideo(uploadedVideoId)` is the service-role entry point:
//   1. Load the uploaded_videos row (service-role; RLS is bypassed).
//   2. Pull the source bytes from the `source-video` bucket.
//        - small enough (≤ ~24MB)  → transcribe the video file directly.
//        - too large for Groq's ~25MB cap → ask MPT to extract a compact mono
//          AAC audio track (POST /api/v1/extract-audio), poll, download the
//          audio.m4a, then transcribe THAT.
//   3. Map Groq's verbose_json segments → TranscriptSegment[] (ms timestamps).
//   4. Pre-render SRT/VTT from those segments (foundation captions helper).
//   5. UPSERT the single video_transcripts row (UNIQUE on uploaded_video_id).
//
// Graceful degrade: when GROQ_API_KEY is unset we DON'T throw — we upsert an
// empty transcript row tagged provider/model null so the editor renders a blank
// hand-entry surface (the operator can wire Groq later, or the user just types
// the transcript). Same shape the /sources flow uses for "paste it instead".
//
// This module is service-role and runs OUTSIDE the request RLS context (called
// from a server action / future cron). It does NOT import any "use client" code.

import { serverEnv, mptConfigured } from "@/lib/env";
import { supabaseService } from "@/lib/supabase/service";
import {
  SOURCE_VIDEO_BUCKET,
  type TranscriptSegment,
} from "@/lib/video/uploads/types";
import { segmentsToSrt, segmentsToVtt } from "@/lib/video/uploads/captions";
import {
  extractAudioTask,
  getTask,
  downloadVideo,
  deleteTask,
  MPT_STATE_COMPLETE,
  MPT_STATE_FAILED,
} from "@/lib/video/mpt-client";

// `uploaded_videos` / `video_transcripts` (migration 068) are not yet in the
// hand-maintained Database type in src/lib/db/types.ts (a shared foundation file
// outside this slice). Until those table defs land there, we go through a
// loosely-typed `.from()` so this slice compiles standalone. Row shapes are
// re-narrowed locally via the typed interfaces in ./types. See the slice return
// note — this cast comes out the moment db/types.ts gains the 068 tables.
type LooseFrom = { from: (table: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
function db() {
  return supabaseService() as unknown as LooseFrom;
}

// Groq's hosted Whisper, OpenAI-compatible. We hit the verbose_json endpoint
// directly (rather than transcribe.ts's transcribeAudioRich) because we need the
// raw SEGMENT array — text + start/end seconds — which that helper doesn't
// surface (it only returns text + jargon hints). Same API + key, narrower read.
const GROQ_API_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const DEFAULT_MODEL = "whisper-large-v3-turbo";

// Groq/OpenAI audio endpoints reject files over ~25MB. We transcribe the raw
// VIDEO directly only when it's comfortably under that; otherwise we route
// through MPT audio extraction. 24MB leaves headroom for multipart overhead.
const DIRECT_TRANSCRIBE_MAX_BYTES = 24 * 1024 * 1024;

export type TranscribeOutcome =
  | { status: "transcribed"; segmentCount: number; via: "video" | "audio" }
  | { status: "empty"; reason: string };

// ── verbose_json shape (defensive narrow — provider-defined, may shift). ──
interface GroqVerboseSegment {
  start?: number; // seconds
  end?: number; // seconds
  text?: string;
}
interface GroqVerboseResponse {
  text?: string;
  language?: string;
  segments?: GroqVerboseSegment[];
}

interface UploadedVideoLite {
  id: string;
  workspace_id: string;
  storage_path: string;
  content_type: string | null;
  size_bytes: number | null;
}

// Map Groq's second-based segments → our ms-based TranscriptSegment[]. Drops
// malformed entries (non-finite times, empty text) and end-before-start cues so
// downstream SRT/VTT rendering never sees garbage. Exported for unit testing.
export function mapGroqSegments(
  resp: GroqVerboseResponse,
): TranscriptSegment[] {
  const raw = Array.isArray(resp.segments) ? resp.segments : [];
  const out: TranscriptSegment[] = [];
  for (const s of raw) {
    if (typeof s.start !== "number" || typeof s.end !== "number") continue;
    if (!Number.isFinite(s.start) || !Number.isFinite(s.end)) continue;
    const text = (s.text ?? "").trim();
    if (text.length === 0) continue;
    const startMs = Math.max(0, Math.round(s.start * 1000));
    const endMs = Math.max(0, Math.round(s.end * 1000));
    if (endMs <= startMs) continue;
    out.push({ startMs, endMs, text });
  }
  return out;
}

// Build the full plain-text transcript from segments when Groq's top-level
// `text` is missing/empty (defensive — usually `text` is present).
function joinSegmentText(
  topLevel: string | undefined,
  segments: TranscriptSegment[],
): string {
  const t = (topLevel ?? "").trim();
  if (t.length > 0) return t;
  return segments.map((s) => s.text).join(" ").trim();
}

// POST the audio/video bytes to Groq's verbose_json endpoint and return the
// parsed response. Throws on transport/HTTP failure so the caller can degrade.
async function groqVerboseTranscribe(
  apiKey: string,
  bytes: ArrayBuffer,
  filename: string,
  contentType: string,
): Promise<GroqVerboseResponse> {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: contentType }), filename);
  form.append("model", DEFAULT_MODEL);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");

  const res = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Groq transcription failed (${res.status}): ${body.slice(0, 200)}`,
    );
  }
  return (await res.json()) as GroqVerboseResponse;
}

// Load the uploaded_videos row we need (service-role; RLS bypassed).
async function loadUploadedVideo(
  id: string,
): Promise<UploadedVideoLite | null> {
  const { data, error } = await db()
    .from("uploaded_videos")
    .select("id, workspace_id, storage_path, content_type, size_bytes")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`loadUploadedVideo failed: ${error.message}`);
  return (data as UploadedVideoLite | null) ?? null;
}

// Download an object's bytes from a private bucket via the service-role client.
async function downloadObject(
  bucket: string,
  path: string,
): Promise<ArrayBuffer> {
  const svc = supabaseService();
  const { data, error } = await svc.storage.from(bucket).download(path);
  if (error || !data) {
    throw new Error(
      `download ${bucket}/${path} failed: ${error?.message ?? "no body"}`,
    );
  }
  return data.arrayBuffer();
}

// When the source is too large for a direct Groq call, route through MPT audio
// extraction: mint a short-lived signed GET url for the private source object,
// POST it to MPT's /extract-audio, poll the task to completion, then download
// the compact `audio.m4a` and transcribe THAT. If MPT isn't configured (or the
// extraction fails / times out) we throw AudioExtractionUnavailableError so the
// caller degrades to an empty hand-entry transcript instead of crashing.
const AUDIO_URL_TTL_SECONDS = 60 * 60; // 1h: covers MPT queue wait + fetch.
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 100; // ~5min ceiling at 3s/attempt.

async function extractAudioViaMpt(
  video: UploadedVideoLite,
): Promise<{ bytes: ArrayBuffer; contentType: string; filename: string }> {
  if (!mptConfigured()) {
    throw new AudioExtractionUnavailableError();
  }

  const svc = supabaseService();
  const { data: signed, error: signErr } = await svc.storage
    .from(SOURCE_VIDEO_BUCKET)
    .createSignedUrl(video.storage_path, AUDIO_URL_TTL_SECONDS);
  if (signErr || !signed?.signedUrl) {
    throw new AudioExtractionUnavailableError();
  }

  let taskId: string;
  try {
    const res = await extractAudioTask({ sourceUrl: signed.signedUrl });
    taskId = res.data.task_id;
  } catch {
    // Transport / not-configured / 4xx from MPT — degrade to hand-entry.
    throw new AudioExtractionUnavailableError();
  }

  try {
    // Poll until the extract-audio task completes (or fails / times out).
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      const task = await getTask(taskId);
      const state = task.data.state;
      if (state === MPT_STATE_COMPLETE) {
        const dl = await downloadVideo(taskId, "audio.m4a");
        const bytes = await dl.arrayBuffer();
        return { bytes, contentType: "audio/mp4", filename: "audio.m4a" };
      }
      if (state === MPT_STATE_FAILED) {
        throw new AudioExtractionUnavailableError();
      }
      await sleep(POLL_INTERVAL_MS);
    }
    // Ran out of polling budget.
    throw new AudioExtractionUnavailableError();
  } finally {
    // Best-effort cleanup of the worker's disk; never blocks the result.
    await deleteTask(taskId).catch(() => {});
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Distinct from a transport error: signals "we can't get transcribe-able audio
// out of this large file yet" so the caller degrades to an empty transcript.
export class AudioExtractionUnavailableError extends Error {
  constructor() {
    super(
      "This video is too large to transcribe directly and audio extraction isn't wired up yet. Type the transcript by hand, or re-upload a shorter clip.",
    );
    this.name = "AudioExtractionUnavailableError";
  }
}

// UPSERT the single transcript row for a source (UNIQUE on uploaded_video_id).
// Used for both the populated and the empty/degraded cases. Never flips
// `edited` here — that's owned by the save-edit action.
async function upsertTranscript(input: {
  workspaceId: string;
  uploadedVideoId: string;
  language: string | null;
  text: string | null;
  segments: TranscriptSegment[];
  srt: string | null;
  vtt: string | null;
  provider: string | null;
  model: string | null;
}): Promise<void> {
  const segmentRows = input.segments.map((s) => ({
    start_ms: s.startMs,
    end_ms: s.endMs,
    text: s.text,
  }));
  const { error } = await db()
    .from("video_transcripts")
    .upsert(
      {
        workspace_id: input.workspaceId,
        uploaded_video_id: input.uploadedVideoId,
        language: input.language,
        text: input.text,
        segments: segmentRows,
        srt: input.srt,
        vtt: input.vtt,
        provider: input.provider,
        model: input.model,
        edited: false,
      },
      { onConflict: "uploaded_video_id" },
    );
  if (error) throw new Error(`upsertTranscript failed: ${error.message}`);
}

// Service-role entry point. Transcribes the source video and upserts the
// transcript row. Never throws on a "can't transcribe" condition (missing key,
// too-large-without-MPT) — it stores an empty transcript and returns an
// `{ status: "empty" }` outcome so the UI can degrade to hand-entry. Only
// genuinely exceptional failures (missing row, storage/network error) throw.
export async function transcribeUploadedVideo(
  uploadedVideoId: string,
): Promise<TranscribeOutcome> {
  const video = await loadUploadedVideo(uploadedVideoId);
  if (!video) {
    throw new Error(`uploaded_video ${uploadedVideoId} not found`);
  }

  const apiKey = serverEnv().GROQ_API_KEY;

  // Graceful degrade: no transcription engine configured → store an empty
  // transcript so the editor renders a blank hand-entry surface.
  if (!apiKey) {
    await upsertTranscript({
      workspaceId: video.workspace_id,
      uploadedVideoId,
      language: null,
      text: null,
      segments: [],
      srt: null,
      vtt: null,
      provider: null,
      model: null,
    });
    return { status: "empty", reason: "transcription-not-configured" };
  }

  // Pick the bytes to transcribe: small → the video itself; large → MPT audio.
  let bytes: ArrayBuffer;
  let contentType: string;
  let filename: string;
  let via: "video" | "audio";
  const size = video.size_bytes ?? 0;

  try {
    if (size > 0 && size <= DIRECT_TRANSCRIBE_MAX_BYTES) {
      bytes = await downloadObject(SOURCE_VIDEO_BUCKET, video.storage_path);
      contentType = video.content_type ?? "video/mp4";
      filename = "source.mp4";
      via = "video";
    } else if (size === 0) {
      // Unknown size — try a direct download; if it's actually huge Groq will
      // reject it and we degrade. Cheaper than a probe for the common case.
      bytes = await downloadObject(SOURCE_VIDEO_BUCKET, video.storage_path);
      contentType = video.content_type ?? "video/mp4";
      filename = "source.mp4";
      via = "video";
    } else {
      const audio = await extractAudioViaMpt(video);
      bytes = audio.bytes;
      contentType = audio.contentType;
      filename = audio.filename;
      via = "audio";
    }
  } catch (err) {
    if (err instanceof AudioExtractionUnavailableError) {
      await upsertTranscript({
        workspaceId: video.workspace_id,
        uploadedVideoId,
        language: null,
        text: null,
        segments: [],
        srt: null,
        vtt: null,
        provider: null,
        model: null,
      });
      return { status: "empty", reason: "audio-extraction-unavailable" };
    }
    throw err;
  }

  const resp = await groqVerboseTranscribe(apiKey, bytes, filename, contentType);
  const segments = mapGroqSegments(resp);
  const text = joinSegmentText(resp.text, segments);
  const srt = segmentsToSrt(segments);
  const vtt = segmentsToVtt(segments);

  await upsertTranscript({
    workspaceId: video.workspace_id,
    uploadedVideoId,
    language: resp.language ?? null,
    text: text.length > 0 ? text : null,
    segments,
    srt: srt.length > 0 ? srt : null,
    vtt,
    provider: "groq",
    model: DEFAULT_MODEL,
  });

  return { status: "transcribed", segmentCount: segments.length, via };
}
