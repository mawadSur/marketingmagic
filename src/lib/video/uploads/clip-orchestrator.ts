// Clip-cut orchestration for the user-video-upload feature (migration 068).
//
// `startClipJobs` is the single entry point that kicks off cutting one or more
// clips out of an already-uploaded source video. It mirrors the shape of
// startVideoRender (orchestrator.ts) but for the BYO-clip path:
//
//   1. Gate on the feature flag + validate the requested clips.
//   2. Plan-gate on the monthly video quota (one unit per clip).
//   3. Mint a short-lived Supabase signed GET url for the raw source object so
//      MPT can fetch it directly (the source bucket is private).
//   4. Build the MPT clip request — slicing the source transcript per clip and
//      re-basing the captions to each clip's window when burn-captions is on.
//   5. POST all clips to MPT in ONE task, then fan that single task id out
//      across one video_jobs row per clip (params.kind = "user_clip").
//
// The poll-video-jobs cron branches on params.kind === "user_clip" to finish
// each job: download `<task_id>/<label>.mp4`, upload to post-media-video, attach
// a draft post, mark ready. All clips in a batch share one mpt_task_id; each job
// only ever pulls its own <label>.mp4.

import type { Json } from "@/lib/db/types";
import { assertWithinVideoQuota } from "@/lib/billing/limits";
import { incrementVideosGenerated } from "@/lib/billing/usage";
import { mptConfigured, userVideoUploadEnabled } from "@/lib/env";
import { supabaseService } from "@/lib/supabase/service";
import { createJob, markFailed, markProcessing } from "@/lib/video/jobs";
import { createClipTask, type MptClipRequest, type VideoAspect } from "@/lib/video/mpt-client";
import { segmentsToSrt, sliceSegments } from "@/lib/video/uploads/captions";
import {
  SOURCE_VIDEO_BUCKET,
  type ClipSpec,
  type TranscriptSegment,
  type TranscriptSegmentRow,
} from "@/lib/video/uploads/types";

// How long MPT has to fetch the source before the signed url expires. MPT
// downloads the source at task start, so this only needs to cover the queue
// wait + the fetch, not the whole render. 1h is generous headroom.
const SOURCE_URL_TTL_SECONDS = 60 * 60;

// Hard ceiling on clips per batch — guards against an unbounded request fanning
// out into hundreds of jobs + a huge MPT payload.
const MAX_CLIPS_PER_BATCH = 20;

export class ClipJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClipJobError";
  }
}

export interface StartClipJobsInput {
  // The clips to cut. Each carries its own [startMs,endMs) window, output label,
  // and burn-captions toggle.
  clips: ClipSpec[];
  // Optional output aspect hint passed straight through to MPT (e.g. "9:16").
  aspect?: VideoAspect;
  // Optional destination channel for the eventual publish, threaded onto each
  // job exactly like the MPT/reference paths.
  socialAccountId?: string | null;
  // The source transcript's segments, used to slice + re-base per-clip captions
  // when a clip has burnCaptions on. Absent/empty → no burned captions even if
  // requested (nothing to burn).
  transcriptSegments?: TranscriptSegment[];
}

export interface StartClipJobsResult {
  mptTaskId: string;
  jobs: Array<{ jobId: string; label: string }>;
}

// Map the persisted (snake_case) transcript segment rows onto the in-app shape.
// Tolerant of partially-bad rows — a non-finite timestamp slices to nothing.
function toSegments(rows: TranscriptSegmentRow[] | TranscriptSegment[]): TranscriptSegment[] {
  return (rows ?? []).map((r) => {
    const rec = r as unknown as Record<string, unknown>;
    const startMs = typeof rec.startMs === "number" ? rec.startMs : Number(rec.start_ms);
    const endMs = typeof rec.endMs === "number" ? rec.endMs : Number(rec.end_ms);
    return { startMs, endMs, text: String(rec.text ?? "") };
  });
}

// fs-safe slug check — the label becomes an output filename + a video_jobs col.
// Reject anything that could escape the path or break the download endpoint.
function isSafeLabel(label: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(label);
}

export async function startClipJobs(
  workspaceId: string,
  uploadedVideoId: string,
  input: StartClipJobsInput,
): Promise<StartClipJobsResult> {
  // Validate at the boundary — bail before touching the DB or MPT.
  if (!userVideoUploadEnabled()) {
    throw new ClipJobError("Video upload is not enabled on this deployment.");
  }
  if (!mptConfigured()) {
    throw new ClipJobError("Clip cutting is not available (MPT is not configured).");
  }
  if (!workspaceId || !uploadedVideoId) {
    throw new ClipJobError("workspaceId and uploadedVideoId are required.");
  }

  const clips = input.clips ?? [];
  if (clips.length === 0) {
    throw new ClipJobError("At least one clip is required.");
  }
  if (clips.length > MAX_CLIPS_PER_BATCH) {
    throw new ClipJobError(`Too many clips (max ${MAX_CLIPS_PER_BATCH} per batch).`);
  }

  // Per-clip validation + duplicate-label guard (labels are output filenames).
  const seen = new Set<string>();
  for (const clip of clips) {
    if (!clip.label || !isSafeLabel(clip.label)) {
      throw new ClipJobError(`Invalid clip label: ${JSON.stringify(clip.label)}`);
    }
    if (seen.has(clip.label)) {
      throw new ClipJobError(`Duplicate clip label: ${clip.label}`);
    }
    seen.add(clip.label);
    if (
      !Number.isFinite(clip.startMs) ||
      !Number.isFinite(clip.endMs) ||
      clip.startMs < 0 ||
      clip.endMs <= clip.startMs
    ) {
      throw new ClipJobError(`Invalid clip window for "${clip.label}" (need 0 <= start < end).`);
    }
  }

  // Plan-gate BEFORE the DB / MPT — one quota unit per clip. Throws a typed
  // QuotaExceededError the server action surfaces as an upgrade nudge.
  await assertWithinVideoQuota(workspaceId, clips.length);

  const svc = supabaseService();

  // Load the source row to resolve its storage path (and confirm it belongs to
  // the workspace). Service-role read; the upload action already enforced
  // ownership when the row was created.
  // uploaded_videos isn't in the generated Database types until they're
  // regenerated for migration 068 (same convention as the sibling uploads/*
  // modules — leave .from() raw, narrow `data` below).
  const { data: sourceRaw, error: srcErr } = await svc
    .from("uploaded_videos")
    .select("id, workspace_id, storage_path, status")
    .eq("id", uploadedVideoId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (srcErr) {
    throw new ClipJobError(`Failed to load source video: ${srcErr.message}`);
  }
  // Cast: uploaded_videos isn't in the generated Database types until they're
  // regenerated for migration 068 (same as the sibling uploads/* modules).
  const source = sourceRaw as { storage_path: string | null; status: string } | null;
  if (!source || !source.storage_path) {
    throw new ClipJobError("Source video not found for this workspace.");
  }
  if (source.status !== "ready") {
    throw new ClipJobError("Source video is not ready yet.");
  }

  // Idempotency guard: a transient client retry can resubmit the same clip
  // batch. Look up the non-failed (pending/processing/ready) jobs already cut
  // from this source for this workspace and skip any clip whose label is
  // already covered — so a benign retry doesn't double-meter the monthly video
  // quota (the up-front assertion guards the ceiling; this guards re-billing).
  // Workspace-scoped + uploaded_video_id-scoped; failed jobs are excluded so a
  // genuine re-cut of a previously-failed label is allowed through.
  // uploaded_video_id / clip_label aren't in the generated Database types until
  // they're regenerated for migration 068 — leave .from() raw, narrow below.
  const { data: existingRaw, error: existingErr } = await svc
    .from("video_jobs")
    .select("clip_label")
    .eq("workspace_id", workspaceId)
    .eq("uploaded_video_id", uploadedVideoId)
    .neq("status", "failed");
  if (existingErr) {
    throw new ClipJobError(`Failed to load existing clip jobs: ${existingErr.message}`);
  }
  const existingLabels = new Set(
    ((existingRaw ?? []) as Array<{ clip_label: string | null }>)
      .map((r) => r.clip_label)
      .filter((l): l is string => typeof l === "string" && l.length > 0),
  );

  // Only cut + meter the clips whose label isn't already covered by a non-failed
  // job. A genuinely-new batch keeps every clip; a verbatim resubmit keeps none.
  const newClips = clips.filter((clip) => !existingLabels.has(clip.label));
  if (newClips.length === 0) {
    // Whole batch already in flight / done — nothing to create, nothing to
    // meter. No MPT task is minted on a pure resubmit, so there's no task id.
    return { mptTaskId: "", jobs: [] };
  }

  // Mint a short-lived signed GET url so MPT (no Supabase creds) can fetch the
  // private source object itself.
  const { data: signed, error: signErr } = await svc.storage
    .from(SOURCE_VIDEO_BUCKET)
    .createSignedUrl(source.storage_path, SOURCE_URL_TTL_SECONDS);
  if (signErr || !signed?.signedUrl) {
    throw new ClipJobError(`Failed to sign source url: ${signErr?.message ?? "no url"}`);
  }

  const segments = toSegments(input.transcriptSegments ?? []);

  // Build the MPT clip request + persist one job per clip. We create the jobs in
  // `pending` FIRST so a row exists even if the MPT POST throws (it gets failed
  // below), then flip every job to `processing` once MPT accepts the batch.
  const aspect = input.aspect;
  const mptClips: MptClipRequest[] = [];
  const jobIds: Array<{ jobId: string; label: string }> = [];

  for (const clip of newClips) {
    // Only compute/burn captions when asked AND we actually have segments.
    const wantsCaptions = clip.burnCaptions && segments.length > 0;
    const sliced = wantsCaptions ? sliceSegments(segments, clip.startMs, clip.endMs) : [];
    const subtitlesSrt = wantsCaptions && sliced.length > 0 ? segmentsToSrt(sliced) : undefined;
    const effectiveBurn = Boolean(subtitlesSrt);

    mptClips.push({
      label: clip.label,
      start_ms: Math.round(clip.startMs),
      end_ms: Math.round(clip.endMs),
      burn_captions: effectiveBurn,
      ...(subtitlesSrt ? { subtitles_srt: subtitlesSrt } : {}),
    });

    const params: Json = {
      kind: "user_clip",
      uploadedVideoId,
      label: clip.label,
      startMs: Math.round(clip.startMs),
      endMs: Math.round(clip.endMs),
      burnCaptions: effectiveBurn,
      ...(subtitlesSrt ? { subtitlesSrt } : {}),
      ...(aspect ? { aspect } : {}),
    };

    const job = await createJob({
      workspaceId,
      socialAccountId: input.socialAccountId ?? null,
      params,
      uploadedVideoId,
      clipLabel: clip.label,
      clipStartMs: Math.round(clip.startMs),
      clipEndMs: Math.round(clip.endMs),
      burnCaptions: effectiveBurn,
    });
    jobIds.push({ jobId: job.id, label: clip.label });
  }

  // Submit ALL clips in one MPT task. On failure, fail every job we just minted
  // so none is left dangling in `pending`.
  try {
    const res = await createClipTask({
      source_url: signed.signedUrl,
      clips: mptClips,
      ...(aspect ? { aspect } : {}),
    });
    const taskId = res.data.task_id;

    // Fan the single task id across every job + flip them to processing.
    await Promise.all(jobIds.map(({ jobId }) => markProcessing(jobId, taskId)));

    // Meter only once MPT accepted the batch — one unit per NEWLY-created clip.
    // A resubmit that only adds some clips meters just the new ones, so a
    // benign retry of an already-cut label never re-bills the monthly quota.
    await incrementVideosGenerated(workspaceId, newClips.length);

    return { mptTaskId: taskId, jobs: jobIds };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "MPT clip request failed";
    await Promise.all(jobIds.map(({ jobId }) => markFailed(jobId, reason).catch(() => {})));
    throw new ClipJobError(reason);
  }
}
