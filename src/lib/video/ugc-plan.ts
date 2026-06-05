// UGC avatar video — planner pre-population.
//
// When a user generates a posting plan and opts a channel into "UGC avatar
// video", we don't make them fill in a render form per post. Instead we
// PRE-POPULATE a Higgsfield (or other 'present' provider) render request from
// the plan post + the workspace's selected avatar, so the user just APPROVES.
//
// This module is pure (no I/O) so the mapping is unit-testable in isolation; the
// plan action calls buildUgcRenderInput() per opted-in post and hands the result
// to startReferenceVideoRender (which owns quota, consent, keys, and dispatch).

import type { StartReferenceVideoRenderInput } from "@/lib/video/orchestrator";
import type { PresentProvider } from "@/lib/video/reference/stub-provider";

// The avatar a workspace has chosen/uploaded for UGC renders. `imageUrl` is a
// public URL from the workspace-scoped reference-image bucket; `imagePath` is its
// storage path (persisted on the job for cleanup/lookup). Resolved by the caller
// from the workspace's selected avatar before plan kickoff.
export interface UgcAvatar {
  imageUrl: string;
  imagePath: string;
}

// One plan post that should receive a UGC avatar video. Mirrors PlanVideoTarget
// but carries the post copy as the SCRIPT the avatar will speak.
export interface UgcPlanTarget {
  postId: string;
  socialAccountId: string;
  channel: string;
  // Seeds the draft caption + the Higgsfield prompt fallback (the idea theme).
  videoSubject: string;
  // The post's exact copy — the words the UGC avatar should say.
  postText: string;
}

// UGC videos are vertical creator clips by default; keep it configurable but
// default to the format every short-form surface (Reels/TikTok/Shorts) wants.
const UGC_ASPECT = "9:16" as const;
// A sensible default UGC clip length. Higgsfield clamps to its own caps.
const UGC_DEFAULT_DURATION_SECONDS = 15;

// Build a fully pre-populated reference-video render request for a single plan
// post, ready to hand to startReferenceVideoRender. The user does not type any
// of this — they only approve the resulting drafts.
//
// `consentBy` is the acting user's id: by opting the plan into UGC video with a
// chosen avatar they own/are authorised to use, they ARE the consent attestation
// (the orchestrator still requires consert === true, set here).
export function buildUgcRenderInput(
  target: UgcPlanTarget,
  avatar: UgcAvatar,
  opts: {
    presentProvider?: PresentProvider;
    consentBy?: string | null;
    durationSeconds?: number;
  } = {},
): StartReferenceVideoRenderInput {
  const script = target.postText.trim();
  return {
    capability: "present",
    // Default the UGC provider to Higgsfield; overridable per workspace.
    presentProvider: opts.presentProvider ?? "higgsfield_video",
    referenceImageUrl: avatar.imageUrl,
    referenceImagePath: avatar.imagePath,
    // The avatar speaks the post copy; the subject is the prompt-flavour fallback.
    script,
    prompt: target.videoSubject,
    videoSubject: target.videoSubject,
    videoAspect: UGC_ASPECT,
    durationSeconds: opts.durationSeconds ?? UGC_DEFAULT_DURATION_SECONDS,
    // Plan-level opt-in with a chosen, owned avatar is the consent attestation.
    consent: true,
    consentBy: opts.consentBy ?? null,
    socialAccountId: target.socialAccountId,
  };
}

// Whether a plan post is eligible for a UGC avatar video. UGC needs an avatar
// AND non-empty copy for the avatar to speak — an empty script has nothing to
// present, so we skip it (the post still saves as text).
export function isUgcEligible(target: UgcPlanTarget, avatar: UgcAvatar | null): boolean {
  if (!avatar?.imageUrl?.trim() || !avatar?.imagePath?.trim()) return false;
  return target.postText.trim().length > 0;
}
