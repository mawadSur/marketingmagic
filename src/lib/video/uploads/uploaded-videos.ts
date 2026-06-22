// CRUD helpers for the `uploaded_videos` table (migration 068).
//
// Thin, intention-revealing wrappers over the SERVICE-ROLE client so the upload
// actions never hand-roll the same insert/update twice. Service-role only —
// callers must authorize the workspace themselves (the actions do, via
// is_workspace_member-backed workspace helpers) before reaching here.
//
// Snake_case `*Row` shapes mirror the DB exactly; `mapUploadedVideo` bridges to
// the camelCase domain type in types.ts.

import { supabaseService } from "@/lib/supabase/service";
import {
  SOURCE_VIDEO_BUCKET,
  type UploadedVideo,
  type UploadedVideoRow,
} from "@/lib/video/uploads/types";

// Row → domain mapper. Kept here next to the queries that produce the rows.
export function mapUploadedVideo(row: UploadedVideoRow): UploadedVideo {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    uploadedBy: row.uploaded_by,
    storagePath: row.storage_path,
    originalFilename: row.original_filename,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    durationSeconds: row.duration_seconds,
    width: row.width,
    height: row.height,
    status: row.status,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateUploadedVideoInput {
  id: string;
  workspaceId: string;
  uploadedBy: string | null;
  storagePath: string;
  originalFilename: string | null;
  contentType: string | null;
  sizeBytes: number | null;
}

// Insert a fresh `uploading` row. The id is minted by the caller so the storage
// path (`<workspace_id>/<id>/source.<ext>`) can be built BEFORE the row exists
// (the signed upload URL needs the path up front). Returns the domain shape.
export async function createUploadedVideo(
  input: CreateUploadedVideoInput,
): Promise<UploadedVideo> {
  const svc = supabaseService();
  const { data, error } = await svc
    .from("uploaded_videos")
    .insert({
      id: input.id,
      workspace_id: input.workspaceId,
      uploaded_by: input.uploadedBy,
      storage_path: input.storagePath,
      original_filename: input.originalFilename,
      content_type: input.contentType,
      size_bytes: input.sizeBytes,
      status: "uploading",
    })
    .select("*")
    .single<UploadedVideoRow>();
  if (error || !data) {
    throw new Error(
      `createUploadedVideo failed: ${error?.message ?? "no row returned"}`,
    );
  }
  return mapUploadedVideo(data);
}

// Fetch one row by id, scoped to a workspace (defence in depth — the caller has
// already authorized the workspace, but we never let an id from one workspace
// resolve a row in another). Returns null when not found.
export async function getUploadedVideo(
  workspaceId: string,
  id: string,
): Promise<UploadedVideo | null> {
  const svc = supabaseService();
  const { data, error } = await svc
    .from("uploaded_videos")
    .select("*")
    .eq("id", id)
    .eq("workspace_id", workspaceId)
    .maybeSingle<UploadedVideoRow>();
  if (error) {
    throw new Error(`getUploadedVideo failed: ${error.message}`);
  }
  return data ? mapUploadedVideo(data) : null;
}

export interface ProbedMetadata {
  durationSeconds?: number | null;
  width?: number | null;
  height?: number | null;
}

// Flip an `uploading` row to `ready` once the browser confirms the bytes
// landed, stamping the client-probed metadata. Scoped to the workspace.
export async function markUploadedVideoReady(
  workspaceId: string,
  id: string,
  meta: ProbedMetadata,
): Promise<UploadedVideo> {
  const svc = supabaseService();
  const { data, error } = await svc
    .from("uploaded_videos")
    .update({
      status: "ready",
      failure_reason: null,
      duration_seconds: meta.durationSeconds ?? null,
      width: meta.width ?? null,
      height: meta.height ?? null,
    })
    .eq("id", id)
    .eq("workspace_id", workspaceId)
    .select("*")
    .single<UploadedVideoRow>();
  if (error || !data) {
    throw new Error(
      `markUploadedVideoReady failed: ${error?.message ?? "no row returned"}`,
    );
  }
  return mapUploadedVideo(data);
}

// Mark a row `failed` (e.g. the browser upload errored after the row was
// inserted). Best-effort cleanup hook for the action's error path.
export async function markUploadedVideoFailed(
  workspaceId: string,
  id: string,
  reason: string,
): Promise<void> {
  const svc = supabaseService();
  await svc
    .from("uploaded_videos")
    .update({ status: "failed", failure_reason: reason.slice(0, 500) })
    .eq("id", id)
    .eq("workspace_id", workspaceId);
}

// Confirm the bytes actually landed in the source-video bucket before we trust a
// client's "upload finished" call. A buggy/hostile client could PUT nothing yet
// call register, leaving a 'ready' row over a missing object — so register checks
// this first. `storagePath` is `<workspace_id>/<id>/source.<ext>`; we list the
// `<workspace_id>/<id>` folder and look for the `source.<ext>` entry with bytes.
// Returns false on error/missing — never throws (callers gate, not trust).
export async function sourceObjectExists(storagePath: string): Promise<boolean> {
  const slash = storagePath.lastIndexOf("/");
  // No folder segment means it can't be a valid `<ws>/<id>/source.<ext>` path.
  if (slash <= 0) return false;
  const folder = storagePath.slice(0, slash);
  const name = storagePath.slice(slash + 1);
  try {
    const svc = supabaseService();
    const { data, error } = await svc.storage
      .from(SOURCE_VIDEO_BUCKET)
      .list(folder, { search: name, limit: 100 });
    if (error || !data) return false;
    // `search` is a prefix/contains filter on Supabase's side, so we still match
    // the exact filename ourselves and require a non-zero byte size.
    return data.some(
      (entry) => entry.name === name && (entry.metadata?.size ?? 0) > 0,
    );
  } catch {
    return false;
  }
}

// Re-export for callers that build storage paths next to these helpers.
export { SOURCE_VIDEO_BUCKET };
