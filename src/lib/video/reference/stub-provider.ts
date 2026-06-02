// SPIKE — Stub reference-image video provider.
//
// This is the ONLY implementation of ReferenceVideoProvider today. Every method
// throws ReferenceVideoNotEnabledError, so the shape is fully defined without
// committing to a vendor or making any live external call. Swap this for a real
// adapter (recommended: a fal.ai image-to-video adapter — see the spike doc)
// once the vendor decision is made and the feature flag is flipped.
//
// getReferenceVideoProvider() is the single resolution point. It guards on the
// REFERENCE_VIDEO_ENABLED feature flag first, then returns the registered
// provider — for now always the stub, so even with the flag ON nothing renders
// until a real adapter is registered here.

import { referenceVideoEnabled } from "@/lib/env";
import { falReferenceVideoProvider } from "./fal-video-provider";
import { didReferenceVideoProvider } from "./did-video-provider";
import { heygenReferenceVideoProvider } from "./heygen-video-provider";
import {
  ReferenceVideoNotEnabledError,
  type ReferenceVideoCapability,
  type ReferenceVideoInputs,
  type ReferenceVideoPoll,
  type ReferenceVideoProvider,
  type ReferenceVideoSubmitResult,
} from "./provider";

// The two 'present' (talking-avatar) providers a user can choose between. The
// 'animate' capability is always fal, so it has no provider knob. The orchestrator
// + poll-cron pass one of these so the factory can resolve D-ID vs HeyGen.
export type PresentProvider = "did_video" | "heygen_video";

export class StubReferenceVideoProvider implements ReferenceVideoProvider {
  readonly name = "stub";

  async submit(_input: ReferenceVideoInputs, _apiKey: string): Promise<ReferenceVideoSubmitResult> {
    throw new ReferenceVideoNotEnabledError(
      "Reference-image video has no live provider wired yet (SPIKE). " +
        "See docs/designs/reference-image-video-spike.md.",
    );
  }

  async poll(_providerJobId: string, _apiKey: string): Promise<ReferenceVideoPoll> {
    throw new ReferenceVideoNotEnabledError();
  }

  async fetchBytes(
    _videoUrl: string,
    _apiKey: string,
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    throw new ReferenceVideoNotEnabledError();
  }
}

export const stubReferenceVideoProvider = new StubReferenceVideoProvider();

// Resolve the active reference-image video adapter for a capability. Throws
// ReferenceVideoNotEnabledError when the feature flag is off so call sites fail
// loudly and uniformly. When ON, picks the concrete adapter:
//   "animate"            → fal.ai image-to-video   (Capability A — "animate a photo")
//   "present" (did_video) → D-ID talking avatar    (Capability B — "make it talk")
//   "present" (heygen_video) → HeyGen talking avatar (Capability B — "make it talk")
//
// The capability arg DEFAULTS to "animate" so the already-shipped fal call sites
// (orchestrator + poll cron) keep selecting fal byte-for-byte without passing it.
// For "present" the optional `presentProvider` arg disambiguates D-ID vs HeyGen;
// it DEFAULTS to "did_video" so the original single-provider call
// (getReferenceVideoProvider("present")) still resolves to D-ID unchanged. The
// stub is retained only for typing/tests and is never returned once the flag is
// flipped.
export function getReferenceVideoProvider(
  capability: ReferenceVideoCapability = "animate",
  presentProvider: PresentProvider = "did_video",
): ReferenceVideoProvider {
  if (!referenceVideoEnabled()) {
    throw new ReferenceVideoNotEnabledError();
  }
  if (capability !== "present") {
    return falReferenceVideoProvider;
  }
  return presentProvider === "heygen_video"
    ? heygenReferenceVideoProvider
    : didReferenceVideoProvider;
}
