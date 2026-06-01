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
import { mptConfigured, referenceVideoEnabled } from "@/lib/env";
import { getWorkspaceKeys } from "@/lib/video/byo-keys";
import { createJob, markFailed, markProcessing } from "@/lib/video/jobs";
import { createRenderJob, type CreateRenderParams, type VideoAspect } from "@/lib/video/mpt-client";
import { getReferenceVideoProvider } from "@/lib/video/reference/stub-provider";
import type { ReferenceVideoInputs } from "@/lib/video/reference/provider";

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

// ─────────────────────────────────────────────────────────────────────────────
// Reference-image video (bet ④ · Capability A) — orchestration.
//
// MIRRORS startVideoRender for the NEW image-conditioned generation path
// ("animate the user's uploaded photo into video" via fal.ai image-to-video).
// startVideoRender above is left BYTE-FOR-BYTE untouched. This path:
//   1. Gate on referenceVideoEnabled() + presence of the workspace's fal_video
//      key (instead of MPT + LLM/Pexels keys).
//   2. REQUIRE an explicit consent attestation (likeness/deepfake guard).
//   3. assertWithinVideoQuota (same meter as the MPT path).
//   4. Insert a video_jobs row with params.kind = "reference_image" + the
//      reference pointer + the stored consent attestation.
//   5. Submit to the fal adapter with the decrypted fal key → request_id.
//   6. markProcessing(job.id, request_id); incrementVideosGenerated.
// The poll-video-jobs cron branches on params.kind to finish reference jobs.
// ─────────────────────────────────────────────────────────────────────────────

// Caller-facing reference-video render request. The fal key is NOT here — it's
// pulled from workspace_byo_keys and decrypted internally, so callers never
// handle plaintext credentials (same contract as StartVideoRenderInput).
export interface StartReferenceVideoRenderInput {
  // Public URL of the uploaded reference photo (reference-image bucket).
  referenceImageUrl: string;
  // Storage path of that photo (<workspace_id>/<id>/<file>) — persisted on the
  // job for cleanup/lookup via video_jobs.reference_image_path.
  referenceImagePath: string;
  // Text prompt describing the desired motion/scene.
  prompt: string;
  videoAspect?: VideoAspect;
  durationSeconds?: number;
  // Short human-readable subject — seeds the eventual draft post caption, like
  // the MPT path's videoSubject.
  videoSubject?: string;
  // REQUIRED consent attestation. Must be true — the user affirming
  // "this is me / I have the right to use this person's likeness". Throws when
  // false/absent so a render can never run without it.
  consent: boolean;
  // Who attested (user id) — stored alongside the timestamp for an audit trail.
  consentBy?: string | null;
  // Optional destination channel for the eventual publish.
  socialAccountId?: string | null;
}

export interface StartReferenceVideoRenderResult {
  jobId: string;
  providerJobId: string;
}

export async function startReferenceVideoRender(
  workspaceId: string,
  input: StartReferenceVideoRenderInput,
): Promise<StartReferenceVideoRenderResult> {
  // Flag gate first — nothing runs unless the deployment opted in.
  if (!referenceVideoEnabled()) {
    throw new VideoRenderError("Reference-image video is not enabled on this deployment.");
  }

  // Validate inputs at the boundary.
  const prompt = input.prompt?.trim();
  if (!prompt) {
    throw new VideoRenderError("A prompt is required to animate the reference photo.");
  }
  if (!input.referenceImageUrl?.trim() || !input.referenceImagePath?.trim()) {
    throw new VideoRenderError("A reference photo is required.");
  }

  // Consent is REQUIRED — a render must never run without an explicit
  // likeness attestation. Throw loudly when it's not affirmed.
  if (input.consent !== true) {
    throw new VideoRenderError(
      "Consent is required: confirm this is you, or that you have the documented right to use this person's likeness.",
    );
  }

  // Plan-gate BEFORE the DB / provider, exactly like the MPT path. Throws a
  // typed QuotaExceededError the server action surfaces as an upgrade nudge.
  await assertWithinVideoQuota(workspaceId, 1);

  // Pull and decrypt the workspace's BYO fal video key.
  const keys = await getWorkspaceKeys(workspaceId);
  if (!keys.fal_video?.api_key) {
    throw new VideoRenderError("No fal video API key configured for this workspace.");
  }

  const aspect: VideoAspect = input.videoAspect ?? "9:16";
  const consentAttestedAt = new Date().toISOString();

  // Persist only non-secret params on the job, including the consent attestation
  // (stored for an audit trail) and the reference pointer.
  const params: Json = {
    kind: "reference_image",
    provider: "fal_video",
    reference_path: input.referenceImagePath,
    reference_public_url: input.referenceImageUrl,
    prompt,
    aspect,
    duration_seconds: input.durationSeconds ?? null,
    consent_attested_at: consentAttestedAt,
    consent_by: input.consentBy ?? null,
    video_subject: input.videoSubject?.trim() || prompt.slice(0, 80),
  };

  const job = await createJob({
    workspaceId,
    socialAccountId: input.socialAccountId ?? null,
    params,
    referenceImagePath: input.referenceImagePath,
  });

  // Submit to the fal adapter with the decrypted key.
  const provider = getReferenceVideoProvider();
  const providerInput: ReferenceVideoInputs = {
    referenceImageUrl: input.referenceImageUrl,
    prompt,
    aspect,
    ...(input.durationSeconds ? { durationSeconds: input.durationSeconds } : {}),
  };

  try {
    const { providerJobId } = await provider.submit(providerInput, keys.fal_video.api_key);
    await markProcessing(job.id, providerJobId);
    // Meter only once the provider accepted the render — a submit failure
    // short-circuits to markFailed() and never burns the quota.
    await incrementVideosGenerated(workspaceId, 1);
    return { jobId: job.id, providerJobId };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Reference-video submit failed";
    await markFailed(job.id, reason);
    throw new VideoRenderError(reason);
  }
}
