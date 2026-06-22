// Typed HTTP client for the MoneyPrinterTurbo (MPT) render worker.
//
// MPT runs as an external container (ffmpeg, 5-15min renders — can't live in
// Vercel). This module centralises the base URL + `x-api-key` header and
// wraps the P1 HTTP contract so callers never hand-roll a fetch. Every
// non-2xx response throws a typed `MptError` carrying the status so callers
// can branch (401 bad token, 429 queue full, etc.).
//
// Verified P1 contract:
//   POST   {base}/api/v1/videos              → { data: { task_id } }
//   GET    {base}/api/v1/tasks/{task_id}     → { data: { state, progress, videos, combined_videos } }
//   GET    {base}/api/v1/download/{task_id}/{file}  → streams the mp4
//   DELETE {base}/api/v1/tasks/{task_id}     → frees the worker's disk

import { serverEnv } from "@/lib/env";

export type VideoAspect = "9:16" | "16:9" | "1:1";

// MPT task state codes (from the P1 contract). Not exhaustive on MPT's side,
// but these are the only ones we act on; anything else is treated as "still
// running" by the poll cron.
export const MPT_STATE_FAILED = -1;
export const MPT_STATE_COMPLETE = 1;
export const MPT_STATE_PROCESSING = 4;

// Request body for POST /api/v1/videos. The BYO secrets (llm_api_key,
// pexels_api_keys) are decrypted at dispatch time and passed straight
// through — never persisted on our side beyond the encrypted blob.
export interface CreateRenderParams {
  video_subject: string;
  video_script?: string;
  video_aspect: VideoAspect;
  voice_name?: string;
  subtitle_enabled?: boolean;
  video_source: "pexels";
  video_clip_duration?: number;
  video_count?: number;
  llm_provider: string;
  llm_api_key: string;
  llm_base_url?: string;
  llm_model_name: string;
  pexels_api_keys: string[];
}

export interface CreateRenderResponse {
  status?: number;
  message?: string;
  data: { task_id: string };
}

export interface MptTaskData {
  state: number;
  progress?: number;
  // Paths like "{task_id}/final-1.mp4" relative to the worker.
  videos?: string[];
  combined_videos?: string[];
}

export interface MptTaskResponse {
  data: MptTaskData;
}

// Typed error so callers can branch on the HTTP status (401/429/etc.).
export class MptError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "MptError";
  }
}

// Thrown when video features are invoked but MPT isn't configured. Distinct
// from MptError (which is a transport/HTTP failure) so callers / the cron can
// treat "not configured" as a clean skip rather than a render failure.
export class MptNotConfiguredError extends Error {
  constructor() {
    super("MPT is not configured (set MPT_BASE_URL and MPT_API_TOKEN).");
    this.name = "MptNotConfiguredError";
  }
}

function mptConfig(): { baseUrl: string; token: string } {
  const env = serverEnv();
  if (!env.MPT_BASE_URL || !env.MPT_API_TOKEN) {
    throw new MptNotConfiguredError();
  }
  return { baseUrl: env.MPT_BASE_URL.replace(/\/$/, ""), token: env.MPT_API_TOKEN };
}

// Per-call network timeout. Renders are async (we poll), so the HTTP calls
// themselves are quick — bound them so a hung worker can't hold a serverless
// function open. Mirrors the AbortController idiom used in lib/sources/* and
// lib/preview/scrape.ts. The timeout only bounds time-to-response (connect +
// headers); once fetch resolves we clear it, so a streaming download body keeps
// reading past the budget.
const MPT_FETCH_TIMEOUT_MS = 15_000;

async function mptFetch(
  path: string,
  init?: RequestInit,
  timeoutMs = MPT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const { baseUrl, token } = mptConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "x-api-key": token,
        ...(init?.headers ?? {}),
      },
      // Never cache — task state changes constantly.
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new MptError(`MPT request timed out after ${timeoutMs / 1000}s`, 408);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function readBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

// POST /api/v1/videos — enqueue a render. Returns the task id.
export async function createRenderJob(
  params: CreateRenderParams,
): Promise<CreateRenderResponse> {
  const res = await mptFetch("/api/v1/videos", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const body = await readBody(res);
    throw new MptError(`MPT createRenderJob failed (${res.status})`, res.status, body);
  }
  const json = (await res.json()) as CreateRenderResponse;
  if (!json?.data?.task_id) {
    throw new MptError("MPT createRenderJob returned no task_id", res.status, JSON.stringify(json));
  }
  return json;
}

// GET /api/v1/tasks/{task_id} — poll render state/progress.
export async function getTask(taskId: string): Promise<MptTaskResponse> {
  const res = await mptFetch(`/api/v1/tasks/${encodeURIComponent(taskId)}`);
  if (!res.ok) {
    const body = await readBody(res);
    throw new MptError(`MPT getTask failed (${res.status})`, res.status, body);
  }
  const json = (await res.json()) as MptTaskResponse;
  if (!json?.data) {
    throw new MptError("MPT getTask returned no data", res.status, JSON.stringify(json));
  }
  return json;
}

// GET /api/v1/download/{task_id}/{file} — stream the finished mp4. Returns
// the raw Response so the caller can pipe `res.body` straight into Supabase
// Storage without buffering the whole file into memory.
export async function downloadVideo(taskId: string, fileName: string): Promise<Response> {
  const res = await mptFetch(
    `/api/v1/download/${encodeURIComponent(taskId)}/${encodeURIComponent(fileName)}`,
  );
  if (!res.ok) {
    const body = await readBody(res);
    throw new MptError(`MPT downloadVideo failed (${res.status})`, res.status, body);
  }
  return res;
}

// DELETE /api/v1/tasks/{task_id} — free the worker's disk after we've pulled
// the file. Best-effort: callers should not fail a job if cleanup 404s.
export async function deleteTask(taskId: string): Promise<void> {
  const res = await mptFetch(`/api/v1/tasks/${encodeURIComponent(taskId)}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) {
    const body = await readBody(res);
    throw new MptError(`MPT deleteTask failed (${res.status})`, res.status, body);
  }
}

// Helper: given a videos[] entry like "{task_id}/final-1.mp4", pull just the
// file segment for the download endpoint.
export function fileNameFromVideoPath(videoPath: string): string {
  const parts = videoPath.split("/");
  return parts[parts.length - 1] || videoPath;
}

// ─────────────────────────────────────────────────────────────────────────────
// User-video-upload clip pipeline (migration 068).
//
// Two extra MPT endpoints back the BYO-clip feature. Both take a Supabase signed
// GET url to the raw source object (MPT fetches it itself) and return a task id
// that drives the SAME tasks/{id}/download/{id}/{file}/tasks/{id} state machine
// as createRenderJob — so the poll cron reuses getTask/downloadVideo/deleteTask.
// ─────────────────────────────────────────────────────────────────────────────

// One clip MPT should cut out of the source. `label` is a filesystem-safe slug
// that becomes the output filename (`<task_id>/<label>.mp4`). `subtitles_srt` is
// the per-clip SRT (already sliced + re-based to the clip window) sent only when
// `burn_captions` is true.
export interface MptClipRequest {
  label: string;
  start_ms: number;
  end_ms: number;
  burn_captions: boolean;
  subtitles_srt?: string;
}

// Request body for POST /api/v1/clip. `aspect` is optional; when omitted MPT
// keeps the source aspect.
export interface CreateClipParams {
  source_url: string;
  clips: MptClipRequest[];
  aspect?: VideoAspect;
}

// POST /api/v1/clip — enqueue a clip-cut (per-clip ffmpeg -ss/-to re-encode,
// optional burned captions). Returns the task id. Output mp4s surface in the
// task's videos[] as `<task_id>/<label>.mp4`.
export async function createClipTask(params: CreateClipParams): Promise<CreateRenderResponse> {
  const res = await mptFetch("/api/v1/clip", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const body = await readBody(res);
    throw new MptError(`MPT createClipTask failed (${res.status})`, res.status, body);
  }
  const json = (await res.json()) as CreateRenderResponse;
  if (!json?.data?.task_id) {
    throw new MptError("MPT createClipTask returned no task_id", res.status, JSON.stringify(json));
  }
  return json;
}

// POST /api/v1/extract-audio — ask MPT to pull a compact mono AAC audio track
// (`<task_id>/audio.m4a`) out of a long source so it fits under Groq Whisper's
// ~25MB cap. Returns the task id; the m4a is downloaded via the existing
// download endpoint once the task completes.
export async function extractAudioTask(params: {
  sourceUrl: string;
}): Promise<CreateRenderResponse> {
  const res = await mptFetch("/api/v1/extract-audio", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source_url: params.sourceUrl }),
  });
  if (!res.ok) {
    const body = await readBody(res);
    throw new MptError(`MPT extractAudioTask failed (${res.status})`, res.status, body);
  }
  const json = (await res.json()) as CreateRenderResponse;
  if (!json?.data?.task_id) {
    throw new MptError("MPT extractAudioTask returned no task_id", res.status, JSON.stringify(json));
  }
  return json;
}
