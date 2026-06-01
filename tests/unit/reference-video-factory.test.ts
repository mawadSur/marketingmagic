import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Unit: getReferenceVideoProvider factory (stub-provider.ts) ───────────────
//
// The factory picks the concrete adapter PER CAPABILITY:
//   "animate" (default) → fal.ai image-to-video  (Capability A, name "fal_video")
//   "present"           → D-ID talking avatar     (Capability B, name "did_video")
// and throws when the feature flag is off. We mock @/lib/env so the provider
// modules import cleanly and no live call is possible.

const referenceVideoEnabled = vi.fn<() => boolean>();
vi.mock("@/lib/env", () => ({
  referenceVideoEnabled: () => referenceVideoEnabled(),
  // Consumed lazily by the adapters; values are irrelevant to selection.
  referenceVideoFalModel: () => "fal-ai/test/image-to-video",
  didBaseUrl: () => "https://api.d-id.test",
  didDefaultVoiceId: () => "en-US-DefaultVoice",
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

  it('returns the D-ID adapter for "present"', () => {
    expect(getReferenceVideoProvider("present").name).toBe("did_video");
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
