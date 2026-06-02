import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Unit: getReferenceVideoProvider factory (stub-provider.ts) ───────────────
//
// The factory picks the concrete adapter PER CAPABILITY (+ present provider):
//   "animate" (default)        → fal.ai image-to-video   (Capability A, "fal_video")
//   "present" + did_video (default) → D-ID talking avatar (Capability B, "did_video")
//   "present" + heygen_video   → HeyGen talking avatar    (Capability B, "heygen_video")
// and throws when the feature flag is off. We mock @/lib/env so the provider
// modules import cleanly and no live call is possible.

const referenceVideoEnabled = vi.fn<() => boolean>();
vi.mock("@/lib/env", () => ({
  referenceVideoEnabled: () => referenceVideoEnabled(),
  // Consumed lazily by the adapters; values are irrelevant to selection.
  referenceVideoFalModel: () => "fal-ai/test/image-to-video",
  didBaseUrl: () => "https://api.d-id.test",
  didDefaultVoiceId: () => "en-US-DefaultVoice",
  heygenBaseUrl: () => "https://api.heygen.test",
  heygenDefaultVoiceId: () => "default-voice-id",
}));

import { getReferenceVideoProvider } from "@/lib/video/reference/stub-provider";

beforeEach(() => referenceVideoEnabled.mockReturnValue(true));
afterEach(() => vi.clearAllMocks());

describe("capability → adapter selection", () => {
  it('defaults to the fal adapter ("animate") when no capability is passed', () => {
    expect(getReferenceVideoProvider().name).toBe("fal_video");
  });

  it('returns the fal adapter for "animate"', () => {
    expect(getReferenceVideoProvider("animate").name).toBe("fal_video");
  });

  it('returns the D-ID adapter for "present" (default present provider)', () => {
    expect(getReferenceVideoProvider("present").name).toBe("did_video");
  });

  it('returns the D-ID adapter for "present" + "did_video"', () => {
    expect(getReferenceVideoProvider("present", "did_video").name).toBe("did_video");
  });

  it('returns the HeyGen adapter for "present" + "heygen_video"', () => {
    expect(getReferenceVideoProvider("present", "heygen_video").name).toBe("heygen_video");
  });

  it('ignores the present provider for "animate" (always fal)', () => {
    expect(getReferenceVideoProvider("animate", "heygen_video").name).toBe("fal_video");
  });
});

describe("feature-flag guard", () => {
  it("throws ReferenceVideoNotEnabledError when the flag is off (animate)", () => {
    referenceVideoEnabled.mockReturnValue(false);
    expect(() => getReferenceVideoProvider("animate")).toThrow(/not yet enabled/i);
  });

  it("throws ReferenceVideoNotEnabledError when the flag is off (present)", () => {
    referenceVideoEnabled.mockReturnValue(false);
    expect(() => getReferenceVideoProvider("present")).toThrow(/not yet enabled/i);
  });
});
