// SPIKE — Reference-image video provider interface (bet ④).
//
// This is the vendor-neutral contract for the NEW image-conditioned /
// talking-avatar generation path. It is deliberately abstract so a concrete
// adapter (fal.ai image-to-video — recommended; or HeyGen / D-ID talking-avatar
// later) can be dropped in WITHOUT touching call sites — exactly how
// src/lib/images/provider.ts abstracts fal vs. a future higgsfield.
//
// Nothing here makes a live external call. The only implementation today is the
// throwing stub in ./stub-provider.ts, gated behind referenceVideoEnabled().
//
// See docs/designs/reference-image-video-spike.md for the full design + the
// still-open vendor decision.

// What the user is asking for. `referenceImageUrl` is the uploaded photo
// (a public URL from the workspace-scoped `reference-image` bucket). `prompt`
// drives image-conditioned motion (capability A). `script`/`audio`/`voice` are
// OPTIONAL and only used by a talking-avatar adapter (capability B) — keeping
// them here means a HeyGen/D-ID adapter is a drop-in without changing this
// interface.
export interface ReferenceVideoInputs {
  // Public URL of the reference photo (workspace-scoped storage). Adapters that
  // need raw bytes can fetch this; adapters that accept a URL pass it through.
  referenceImageUrl: string;
  // Text prompt describing the desired motion/scene (capability A).
  prompt: string;
  // Output aspect ratio. Matches the existing VideoAspect vocabulary.
  aspect: "9:16" | "16:9" | "1:1";
  // Target duration in seconds (provider clamps to its own caps).
  durationSeconds?: number;
  // Talking-avatar only (capability B): the words the avatar should speak, OR a
  // URL to pre-rendered audio. Ignored by image-conditioned adapters.
  script?: string;
  audioUrl?: string;
  voiceId?: string;
}

// Handle returned by submit(). Mirrors the MPT task-id contract so the new path
// slots into the same poll-cron pattern (POST → id → poll → pull bytes).
export interface ReferenceVideoSubmitResult {
  // Opaque provider job id (fal request_id, HeyGen video_id, D-ID talk id, …).
  providerJobId: string;
  // Provider name for debugging / metering (e.g. "fal_video").
  provider: string;
}

export type ReferenceVideoStatus = "processing" | "ready" | "failed";

// Poll result. When `status === "ready"`, `videoUrl` is set (a provider CDN URL
// that may expire — callers should pull bytes promptly, like images/fal.ts).
export interface ReferenceVideoPoll {
  status: ReferenceVideoStatus;
  progress?: number; // 0..100 when the provider reports it.
  videoUrl?: string;
  failureReason?: string;
}

// The contract every reference-image video adapter implements. Three calls map
// 1:1 onto the existing orchestrate→poll machinery:
//   submit()  → POST the render, return a job id          (orchestrator)
//   poll()    → GET status/progress                        (poll cron)
//   fetchBytes() → pull the finished mp4 to own the asset  (poll cron)
export interface ReferenceVideoProvider {
  readonly name: string;
  submit(input: ReferenceVideoInputs, apiKey: string): Promise<ReferenceVideoSubmitResult>;
  poll(providerJobId: string, apiKey: string): Promise<ReferenceVideoPoll>;
  fetchBytes(videoUrl: string, apiKey: string): Promise<{ bytes: Uint8Array; contentType: string }>;
}

// Thrown by the stub (and by any guard) when the feature flag is off or no real
// adapter has been wired. Distinct type so call sites can branch on
// "not enabled" vs. a genuine provider/transport failure — same idea as
// MptNotConfiguredError.
export class ReferenceVideoNotEnabledError extends Error {
  constructor(message = "Reference-image video is not yet enabled on this deployment.") {
    super(message);
    this.name = "ReferenceVideoNotEnabledError";
  }
}
