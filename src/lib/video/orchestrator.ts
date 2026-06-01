// Video render orchestration.
//
// `startVideoRender` is the single callable entry point that kicks off a
// render. The UI is P4 — for now this is just a server-side lib function:
//
//   1. Decrypt the workspace's BYO LLM + Pexels keys (service-role only).
//   2. Insert a `video_jobs` row (pending).
//   3. POST the params + keys to MPT.
//   4. Store the returned task id and flip the job to `processing`.
//
// The poll-video-jobs cron takes it from there (pull the mp4, attach to a
// draft post, mark ready/failed).

import { assertWithinVideoQuota } from "@/lib/billing/limits";
import { incrementVideosGenerated } from "@/lib/billing/usage";
import type { Json } from "@/lib/db/types";
import { mptConfigured } from "@/lib/env";
import { getWorkspaceKeys } from "@/lib/video/byo-keys";
import { createJob, markFailed, markProcessing } from "@/lib/video/jobs";
import { createRenderJob, type CreateRenderParams, type VideoAspect } from "@/lib/video/mpt-client";

// Caller-facing render request. The BYO keys are NOT part of this — they're
// pulled from workspace_byo_keys and decrypted internally so callers never
// handle plaintext credentials.
export interface StartVideoRenderInput {
  videoSubject: string;
  videoScript?: string;
  videoAspect?: VideoAspect;
  voiceName?: string;
  subtitleEnabled?: boolean;
  videoClipDuration?: number;
  videoCount?: number;
  // Optional destination channel for the eventual publish (P3).
  socialAccountId?: string | null;
}

export class VideoRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoRenderError";
  }
}

export interface StartVideoRenderResult {
  jobId: string;
  mptTaskId: string;
}

export async function startVideoRender(
  workspaceId: string,
  input: StartVideoRenderInput,
): Promise<StartVideoRenderResult> {
  // Validate at the boundary — bail before touching the DB or MPT.
  if (!mptConfigured()) {
    throw new VideoRenderError("Video rendering is not available (MPT is not configured).");
  }
  const subject = input.videoSubject?.trim();
  if (!subject) {
    throw new VideoRenderError("videoSubject is required.");
  }

  // P4: plan-gate BEFORE we touch the DB or MPT. assertWithinVideoQuota throws
  // a typed QuotaExceededError (re-exported from @/lib/billing/limits) that the
  // server action surfaces as an upgrade nudge. We deliberately don't wrap it
  // in VideoRenderError so the caller can branch on QuotaExceededError.
  await assertWithinVideoQuota(workspaceId, input.videoCount ?? 1);

  // Pull and decrypt the workspace's BYO credentials. Both an LLM provider
  // and at least one Pexels key are required for MPT to render.
  const keys = await getWorkspaceKeys(workspaceId);
  if (!keys.llm) {
    throw new VideoRenderError("No LLM API key configured for this workspace.");
  }
  if (!keys.pexels || keys.pexels.api_keys.length === 0) {
    throw new VideoRenderError("No Pexels API key configured for this workspace.");
  }

  // Persist only the non-secret render parameters on the job.
  const params: Json = {
    video_subject: subject,
    video_script: input.videoScript ?? null,
    video_aspect: input.videoAspect ?? "9:16",
    voice_name: input.voiceName ?? null,
    subtitle_enabled: input.subtitleEnabled ?? true,
    video_clip_duration: input.videoClipDuration ?? null,
    video_count: input.videoCount ?? null,
  };

  const job = await createJob({
    workspaceId,
    socialAccountId: input.socialAccountId ?? null,
    params,
  });

  // Build the MPT request body: non-secret params + decrypted BYO keys.
  const renderParams: CreateRenderParams = {
    video_subject: subject,
    video_aspect: input.videoAspect ?? "9:16",
    video_source: "pexels",
    subtitle_enabled: input.subtitleEnabled ?? true,
    llm_provider: keys.llm.provider,
    llm_api_key: keys.llm.api_key,
    llm_model_name: keys.llm.model_name,
    pexels_api_keys: keys.pexels.api_keys,
  };
  if (input.videoScript) renderParams.video_script = input.videoScript;
  if (input.voiceName) renderParams.voice_name = input.voiceName;
  if (input.videoClipDuration) renderParams.video_clip_duration = input.videoClipDuration;
  if (input.videoCount) renderParams.video_count = input.videoCount;
  if (keys.llm.base_url) renderParams.llm_base_url = keys.llm.base_url;

  try {
    const res = await createRenderJob(renderParams);
    const taskId = res.data.task_id;
    await markProcessing(job.id, taskId);
    // Meter the render only once MPT has accepted it — a transport failure
    // below short-circuits to markFailed() and never reaches here, so a
    // rejected render doesn't burn the workspace's monthly quota.
    await incrementVideosGenerated(workspaceId, input.videoCount ?? 1);
    return { jobId: job.id, mptTaskId: taskId };
  } catch (err) {
    // Surface the failure on the job so it isn't left dangling in `pending`.
    const reason = err instanceof Error ? err.message : "MPT render request failed";
    await markFailed(job.id, reason);
    throw new VideoRenderError(reason);
  }
}
