"use server";

// SLICE A — User video upload · server actions.
//
// Raw user videos blow past the 6MB server-action body limit, so we DON'T stream
// the bytes through the server. Instead the browser uploads DIRECTLY to Supabase
// Storage via a short-lived SIGNED UPLOAD URL minted here:
//
//   1. createUploadTicketAction — authorize the workspace, validate the file
//      meta (mime allowlist + size cap) at the boundary, insert an
//      `uploaded_videos` row in status='uploading', mint a signed upload URL/
//      token into the source-video bucket at
//      `<workspace_id>/<uploadedVideoId>/source.<ext>`, return the ticket. The
//      browser then PUTs the bytes straight to that URL.
//
//   2. registerUploadedVideoAction — once the browser confirms the bytes landed,
//      flip the row to status='ready', stamp the client-probed metadata, and
//      (best-effort, non-blocking) kick off transcription (slice B).
//
// Hard-gated by userVideoUploadEnabled(): with the flag off both actions refuse
// so nothing ships live. The signed-URL mint + row insert run on the SERVICE-ROLE
// client (the bucket is private); the workspace is authorized FIRST via the
// is_workspace_member-backed workspace helpers, so service-role never escapes
// the caller's tenant.

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { userVideoUploadEnabled } from "@/lib/env";
import { getAuthedUserOrRedirect, getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseService } from "@/lib/supabase/service";
import {
  SOURCE_VIDEO_BUCKET,
  createUploadedVideo,
  getUploadedVideo,
  markUploadedVideoReady,
} from "@/lib/video/uploads/uploaded-videos";

import { transcribeUploadedVideo } from "@/lib/video/uploads/transcribe-video";

// ── Boundary validation ──────────────────────────────────────────────────────
// Mime allowlist matches the source-video bucket (migration 068). Size cap is
// the bucket's 2GB; we reject earlier here for a friendlier error than a storage
// 413. Keep these in sync with the bucket definition.
const ALLOWED_MIME = new Set(["video/mp4", "video/quicktime", "video/webm"]);
const MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2GB — matches the bucket cap in 068.

const EXT_BY_MIME: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

export interface UploadTicket {
  uploadedVideoId: string;
  path: string;
  token: string;
}

export type UploadTicketResult =
  | { ok: true; ticket: UploadTicket }
  | { ok: false; error: string };

const ticketSchema = z.object({
  // We don't trust the client's workspaceId for authorization — the active
  // workspace from the session wins. We accept it only to fail loudly on a
  // mismatch (stale tab pointed at another workspace).
  workspaceId: z.string().uuid().optional(),
  filename: z.string().trim().min(1).max(512),
  contentType: z.string().trim().min(1).max(255),
  size: z.number().int().positive().max(MAX_BYTES),
});

export async function createUploadTicketAction(
  workspaceId: string,
  filename: string,
  contentType: string,
  size: number,
): Promise<UploadTicketResult> {
  if (!userVideoUploadEnabled()) {
    return { ok: false, error: "Video upload isn't enabled on this deployment yet." };
  }

  const user = await getAuthedUserOrRedirect();
  const ws = await getActiveWorkspaceOrRedirect();

  const parsed = ticketSchema.safeParse({
    workspaceId: workspaceId || undefined,
    filename,
    contentType,
    size,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid upload request." };
  }

  // The active session's workspace is the source of truth. If the client passed
  // a workspaceId that doesn't match, the tab is stale — refuse rather than
  // upload into the wrong tenant.
  if (parsed.data.workspaceId && parsed.data.workspaceId !== ws.id) {
    return { ok: false, error: "Your workspace changed. Reload the page and try again." };
  }

  if (!ALLOWED_MIME.has(parsed.data.contentType)) {
    return { ok: false, error: "Video must be MP4, MOV, or WebM." };
  }
  if (parsed.data.size > MAX_BYTES) {
    return { ok: false, error: "Video must be 2GB or smaller." };
  }

  const uploadedVideoId = randomUUID();
  const ext = EXT_BY_MIME[parsed.data.contentType] ?? "mp4";
  // Workspace-prefixed so the bucket RLS (split_part(name,'/',1)) authorizes a
  // member upload; the {id} segment isolates each source's clips + cleanup.
  const path = `${ws.id}/${uploadedVideoId}/source.${ext}`;

  const svc = supabaseService();
  const { data: signed, error: signErr } = await svc.storage
    .from(SOURCE_VIDEO_BUCKET)
    .createSignedUploadUrl(path);
  if (signErr || !signed) {
    return { ok: false, error: `Couldn't start upload: ${signErr?.message ?? "no token"}` };
  }

  // Record the upload BEFORE the bytes land so a half-finished upload is still
  // visible (status='uploading') and reapable. If this insert fails we have a
  // dangling signed URL but no row — harmless (nothing references it).
  try {
    await createUploadedVideo({
      id: uploadedVideoId,
      workspaceId: ws.id,
      uploadedBy: user.id,
      storagePath: path,
      originalFilename: parsed.data.filename,
      contentType: parsed.data.contentType,
      sizeBytes: parsed.data.size,
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't record the upload.",
    };
  }

  return { ok: true, ticket: { uploadedVideoId, path, token: signed.token } };
}

// ── 2. Finalise ──────────────────────────────────────────────────────────────
export interface RegisterMetadata {
  duration?: number | null;
  width?: number | null;
  height?: number | null;
}

export type RegisterResult =
  | { ok: true; uploadedVideoId: string }
  | { ok: false; error: string };

const registerSchema = z.object({
  uploadedVideoId: z.string().uuid(),
  // Client-probed via the <video> element. Best-effort; all optional/nullable.
  duration: z.number().finite().nonnegative().max(86_400).nullish(),
  width: z.number().int().positive().max(16_384).nullish(),
  height: z.number().int().positive().max(16_384).nullish(),
});

export async function registerUploadedVideoAction(
  uploadedVideoId: string,
  meta: RegisterMetadata,
): Promise<RegisterResult> {
  if (!userVideoUploadEnabled()) {
    return { ok: false, error: "Video upload isn't enabled on this deployment yet." };
  }

  await getAuthedUserOrRedirect();
  const ws = await getActiveWorkspaceOrRedirect();

  const parsed = registerSchema.safeParse({
    uploadedVideoId,
    duration: meta.duration ?? null,
    width: meta.width ?? null,
    height: meta.height ?? null,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid request." };
  }

  // Scope the row to the active workspace — an id from another tenant resolves
  // to null and is rejected, even though the helper runs service-role.
  const existing = await getUploadedVideo(ws.id, parsed.data.uploadedVideoId);
  if (!existing) {
    return { ok: false, error: "That upload doesn't belong to this workspace." };
  }

  try {
    await markUploadedVideoReady(ws.id, parsed.data.uploadedVideoId, {
      durationSeconds: parsed.data.duration ?? null,
      width: parsed.data.width ?? null,
      height: parsed.data.height ?? null,
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't finalise the upload.",
    };
  }

  // Fire-and-forget transcription (slice B). Never blocks the user landing in
  // the editor; a transcription failure must not fail the upload.
  kickOffTranscription(ws.id, parsed.data.uploadedVideoId);

  revalidatePath("/video/upload");
  return { ok: true, uploadedVideoId: parsed.data.uploadedVideoId };
}

// Best-effort transcription kickoff. transcribeUploadedVideo loads the source
// row (and its workspace) itself, so it only needs the uploaded-video id. It
// never throws on a "can't transcribe" condition (missing key / too-large) — it
// upserts an empty transcript and returns — but we still .catch() so a thrown
// transport/DB error can't reject this fire-and-forget promise unhandled.
function kickOffTranscription(workspaceId: string, uploadedVideoId: string): void {
  void workspaceId;
  void transcribeUploadedVideo(uploadedVideoId).catch(() => {});
}
