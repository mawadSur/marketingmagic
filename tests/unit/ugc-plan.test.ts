import { describe, it, expect } from "vitest";
import { buildUgcRenderInput, isUgcEligible } from "@/lib/video/ugc-plan";

// ── Unit: UGC planner pre-population (src/lib/video/ugc-plan.ts) ──────────────
// Pure mapping — the planner pre-fills a Higgsfield render request from a plan
// post + the workspace avatar so the user only approves.

const AVATAR = { imageUrl: "https://cdn/ws/avatar.png", imagePath: "ws/avatar.png" };
const TARGET = {
  postId: "post-1",
  socialAccountId: "acct-1",
  channel: "instagram",
  videoSubject: "Launch week recap",
  postText: "Here's what shipped this week — three features our users asked for.",
};

describe("buildUgcRenderInput", () => {
  it("pre-populates a present/Higgsfield render with the avatar + post copy as script", () => {
    const input = buildUgcRenderInput(TARGET, AVATAR, { consentBy: "user-9" });
    expect(input).toMatchObject({
      capability: "present",
      presentProvider: "higgsfield_video",
      referenceImageUrl: AVATAR.imageUrl,
      referenceImagePath: AVATAR.imagePath,
      script: TARGET.postText,
      prompt: TARGET.videoSubject,
      videoSubject: TARGET.videoSubject,
      videoAspect: "9:16",
      consent: true,
      consentBy: "user-9",
      socialAccountId: "acct-1",
    });
    expect(input.durationSeconds).toBeGreaterThan(0);
  });

  it("trims the script and honours a provider/duration override", () => {
    const input = buildUgcRenderInput(
      { ...TARGET, postText: "  hi there  " },
      AVATAR,
      { presentProvider: "did_video", durationSeconds: 8 },
    );
    expect(input.script).toBe("hi there");
    expect(input.presentProvider).toBe("did_video");
    expect(input.durationSeconds).toBe(8);
  });
});

describe("isUgcEligible", () => {
  it("requires an avatar AND non-empty copy", () => {
    expect(isUgcEligible(TARGET, AVATAR)).toBe(true);
    expect(isUgcEligible(TARGET, null)).toBe(false);
    expect(isUgcEligible({ ...TARGET, postText: "   " }, AVATAR)).toBe(false);
    expect(isUgcEligible(TARGET, { imageUrl: "", imagePath: "" })).toBe(false);
  });
});
