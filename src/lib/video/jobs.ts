// CRUD helpers for the `video_jobs` table.
//
// Thin, intention-revealing wrappers over the service-role client so the
// orchestrator and the poll-video-jobs cron read clearly and never hand-roll
// the same update twice. All helpers are service-role only.

import type { Json } from "@/lib/db/types";
import { supabaseService } from "@/lib/supabase/service";

export type VideoJobStatus = "pending" | "processing" | "ready" | "failed";

export interface VideoJobRow {
  id: string;
  workspace_id: string;
  social_account_id: string | null;
  post_id: string | null;
  status: VideoJobStatus;
  mpt_task_id: string | null;
  params: Json;
  progress: number;
  storage_path: string | null;
  failure_reason: string | null;
  // Reference-image video (bet ④) — the chosen reference photo's storage path
  // in the `reference-image` bucket. Null for MPT jobs (added in migration 030).
  reference_image_path: string | null;
  // User-video-upload clip columns (migration 068). Set only on
  // params.kind === "user_clip" jobs; null on every other video_jobs row. They
  // duplicate the per-clip spec from params so the cron + cleanup can look them
  // up cheaply without re-parsing the jsonb.
  uploaded_video_id: string | null;
  clip_label: string | null;
  clip_start_ms: number | null;
  clip_end_ms: number | null;
  burn_captions: boolean | null;
  created_at: string;
  updated_at: string;
}

export interface CreateJobInput {
  workspaceId: string;
  socialAccountId?: string | null;
  params: Json;
  // Reference-image video (bet ④) — the chosen reference photo path. Omitted by
  // the MPT orchestrator, set by the reference-video orchestrator.
  referenceImagePath?: string | null;
  // Plan videos — the EXISTING plan post this render attaches to. When set, the
  // poll-video-jobs cron UPDATEs that post's media[] instead of inserting a new
  // draft. Omitted by the ad-hoc /video and reference paths.
  postId?: string | null;
  // User-video-upload clip columns (migration 068). Set by the clip orchestrator
  // for params.kind === "user_clip" jobs; omitted by every other path (so the
  // columns stay null). Persisted alongside params for cheap cron/cleanup lookup.
  uploadedVideoId?: string | null;
  clipLabel?: string | null;
  clipStartMs?: number | null;
  clipEndMs?: number | null;
  burnCaptions?: boolean | null;
}

// Insert a fresh job in `pending` state. Returns the new row.
export async function createJob(input: CreateJobInput): Promise<VideoJobRow> {
  const svc = supabaseService();
  // Build the row, then cast on insert: the migration-068 clip columns
  // (uploaded_video_id / clip_* / burn_captions) aren't in the generated
  // Database types until they're regenerated, so the typed insert would reject
  // them. The same `as unknown as never` cast is used elsewhere for additive
  // columns (see uploads/market-clip.ts). Explicit null-checks (not truthiness)
  // so a legit clip_start_ms of 0 still writes.
  const row = {
    workspace_id: input.workspaceId,
    social_account_id: input.socialAccountId ?? null,
    params: input.params,
    status: "pending",
    ...(input.referenceImagePath ? { reference_image_path: input.referenceImagePath } : {}),
    ...(input.postId ? { post_id: input.postId } : {}),
    ...(input.uploadedVideoId != null ? { uploaded_video_id: input.uploadedVideoId } : {}),
    ...(input.clipLabel != null ? { clip_label: input.clipLabel } : {}),
    ...(input.clipStartMs != null ? { clip_start_ms: input.clipStartMs } : {}),
    ...(input.clipEndMs != null ? { clip_end_ms: input.clipEndMs } : {}),
    ...(input.burnCaptions != null ? { burn_captions: input.burnCaptions } : {}),
  };
  const { data, error } = await svc
    .from("video_jobs")
    .insert(row as unknown as never)
    .select("*")
    .single();
  if (error || !data) {
    throw new Error(`createJob failed: ${error?.message ?? "no row returned"}`);
  }
  return data as VideoJobRow;
}

// Move a job to `processing` once MPT has accepted the render and handed back
// a task id.
export async function markProcessing(jobId: string, mptTaskId: string): Promise<void> {
  const svc = supabaseService();
  const { error } = await svc
    .from("video_jobs")
    .update({ status: "processing", mpt_task_id: mptTaskId })
    .eq("id", jobId);
  if (error) throw new Error(`markProcessing failed: ${error.message}`);
}

// Update the 0..100 progress integer reported by MPT. Best-effort: clamps to
// a sane range so a bad upstream value can't write garbage.
export async function updateProgress(jobId: string, progress: number): Promise<void> {
  const clamped = Math.max(0, Math.min(100, Math.round(progress)));
  const svc = supabaseService();
  const { error } = await svc
    .from("video_jobs")
    .update({ progress: clamped })
    .eq("id", jobId);
  if (error) throw new Error(`updateProgress failed: ${error.message}`);
}

// Mark a job ready: the mp4 is in the bucket and (optionally) a draft post is
// attached. Sets progress to 100.
export async function markReady(
  jobId: string,
  storagePath: string,
  postId?: string | null,
): Promise<void> {
  const svc = supabaseService();
  const { error } = await svc
    .from("video_jobs")
    .update({
      status: "ready",
      storage_path: storagePath,
      progress: 100,
      ...(postId ? { post_id: postId } : {}),
    })
    .eq("id", jobId);
  if (error) throw new Error(`markReady failed: ${error.message}`);
}

// Mark a job failed with a reason (MPT FAILED state, download error, etc.).
// Truncates the reason to keep the column tidy.
export async function markFailed(jobId: string, reason: string): Promise<void> {
  const svc = supabaseService();
  const { error } = await svc
    .from("video_jobs")
    .update({ status: "failed", failure_reason: reason.slice(0, 1000) })
    .eq("id", jobId);
  if (error) throw new Error(`markFailed failed: ${error.message}`);
}

// All jobs the poll cron should walk this tick. Ordered oldest-first so a
// backlog drains fairly; capped by `limit` to bound per-tick work.
export async function listProcessing(limit = 25): Promise<VideoJobRow[]> {
  const svc = supabaseService();
  const { data, error } = await svc
    .from("video_jobs")
    .select("*")
    .eq("status", "processing")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`listProcessing failed: ${error.message}`);
  return (data ?? []) as VideoJobRow[];
}
