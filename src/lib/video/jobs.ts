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
  created_at: string;
  updated_at: string;
}

export interface CreateJobInput {
  workspaceId: string;
  socialAccountId?: string | null;
  params: Json;
}

// Insert a fresh job in `pending` state. Returns the new row.
export async function createJob(input: CreateJobInput): Promise<VideoJobRow> {
  const svc = supabaseService();
  const { data, error } = await svc
    .from("video_jobs")
    .insert({
      workspace_id: input.workspaceId,
      social_account_id: input.socialAccountId ?? null,
      params: input.params,
      status: "pending",
    })
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
