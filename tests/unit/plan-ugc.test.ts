import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Unit: plan-generated UGC avatar videos (src/lib/video/plan-ugc.ts) ───────
//
// PARALLEL to tests/unit/plan-videos.test.ts. Covers the UGC opt-in contracts:
//   1. Per-channel parse — `ugc_<accountId>="on"` → the opted-in account set,
//      independent of the `video_` (MPT) opt-in.
//   2. UGC-available + capable gating — shouldGenerateUgcForPost only fires when
//      UGC is available (key + avatar, applied by the caller via ugcAvailable),
//      the account opted in, AND the channel supportsVideo.
//   3. Render failure isolation — a startReferenceVideoRender throw inside the
//      kickoff loop is swallowed (the plan must still save) and the loop continues.
//   4. Quota cap + QuotaExceededError early-stop, mirroring the MPT path.
//   5. Eligibility skip — a post with empty copy (nothing for the avatar to say)
//      is skipped WITHOUT consuming an attempt or quota.
//   6. Pre-population — each kickoff hands startReferenceVideoRender a fully
//      built Higgsfield "present" render input (capability + provider + consent +
//      the avatar pointer + the post copy as the script).
//
// QuotaExceededError is imported from @/lib/billing/limits; we mock that module
// minimally so the loop's `instanceof QuotaExceededError` branch works without
// pulling in supabase. The orchestrator is never invoked — every test injects a
// fake startReferenceVideoRender. We also mock plan-videos.ts's billing deps
// (tiers/usage) so the re-exported remainingVideoQuota resolves in isolation.

vi.mock("@/lib/billing/limits", () => {
  class FakeQuotaError extends Error {
    constructor() {
      super("quota");
      this.name = "QuotaExceededError";
    }
  }
  return { QuotaExceededError: FakeQuotaError };
});

// plan-ugc.ts re-exports remainingVideoQuota from plan-videos.ts, which reads
// tiers + usage. Keep them mockable; default to a generous tier + zero usage.
const tierLimits = { videosPerMonth: 20 };
const usageSnapshot = { videosGenerated: 0 };
vi.mock("@/lib/billing/tiers", () => ({
  tierFor: () => ({ limits: tierLimits }),
}));
vi.mock("@/lib/billing/usage", () => ({
  getUsageSnapshot: async () => usageSnapshot,
}));

import {
  parseUgcOptIns,
  shouldGenerateUgcForPost,
  remainingVideoQuota,
  kickoffPlanUgcVideos,
} from "@/lib/video/plan-ugc";
import type { UgcAvatar, UgcPlanTarget } from "@/lib/video/ugc-plan";
// The mocked QuotaExceededError (same class the kickoff loop branches on).
import { QuotaExceededError } from "@/lib/billing/limits";

// Minimal FormData-shaped stub for parseUgcOptIns (it only calls .entries()).
function fakeFormData(pairs: Array<[string, string]>) {
  return {
    *entries(): IterableIterator<[string, FormDataEntryValue]> {
      for (const p of pairs) yield p as [string, FormDataEntryValue];
    },
  };
}

const avatar: UgcAvatar = {
  imageUrl: "https://example.test/ws/avatar.png",
  imagePath: "ws-1/abc/avatar.png",
};

beforeEach(() => {
  tierLimits.videosPerMonth = 20;
  usageSnapshot.videosGenerated = 0;
});
afterEach(() => vi.clearAllMocks());

describe("parseUgcOptIns (per-channel parse)", () => {
  it("collects only the ugc_<id> keys whose value is 'on'", () => {
    const out = parseUgcOptIns(
      fakeFormData([
        ["include_acc-1", "on"],
        ["ugc_acc-1", "on"],
        ["posts_acc-1", "7"],
        ["ugc_acc-2", "on"],
        // not opted in (unchecked checkboxes don't submit, but be defensive)
        ["ugc_acc-3", "off"],
        // the MPT video opt-in must NOT leak into the UGC set.
        ["video_acc-4", "on"],
      ]),
    );
    expect(out.has("acc-1")).toBe(true);
    expect(out.has("acc-2")).toBe(true);
    expect(out.has("acc-3")).toBe(false);
    expect(out.has("acc-4")).toBe(false);
    expect(out.size).toBe(2);
  });

  it("returns an empty set when no ugc flags are present", () => {
    const out = parseUgcOptIns(fakeFormData([["video_acc-1", "on"]]));
    expect(out.size).toBe(0);
  });
});

describe("UGC-available + capable gating", () => {
  it("requires UGC availability, opt-in, AND a video-capable channel", () => {
    const optedIn = new Set(["acc-1"]);

    // Happy path: available + opted-in + capable channel (x supportsVideo).
    expect(
      shouldGenerateUgcForPost({
        ugcAvailable: true,
        optedInAccountIds: optedIn,
        socialAccountId: "acc-1",
        channel: "x",
      }),
    ).toBe(true);

    // ugcAvailable false (no Higgsfield key / no avatar) → no UGC.
    expect(
      shouldGenerateUgcForPost({
        ugcAvailable: false,
        optedInAccountIds: optedIn,
        socialAccountId: "acc-1",
        channel: "x",
      }),
    ).toBe(false);

    // Account not opted in → no UGC.
    expect(
      shouldGenerateUgcForPost({
        ugcAvailable: true,
        optedInAccountIds: optedIn,
        socialAccountId: "acc-2",
        channel: "x",
      }),
    ).toBe(false);

    // Channel not video-capable → no UGC (defensive — the form hides it too).
    expect(
      shouldGenerateUgcForPost({
        ugcAvailable: true,
        optedInAccountIds: optedIn,
        socialAccountId: "acc-1",
        channel: "not-a-channel",
      }),
    ).toBe(false);
  });
});

describe("remainingVideoQuota (re-exported, shared meter)", () => {
  it("returns the tier ceiling minus usage", async () => {
    tierLimits.videosPerMonth = 20;
    usageSnapshot.videosGenerated = 5;
    expect(await remainingVideoQuota("ws", "pro")).toBe(15);
  });

  it("returns Infinity for an unlimited (-1) tier", async () => {
    tierLimits.videosPerMonth = -1;
    expect(await remainingVideoQuota("ws", "founder")).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("kickoffPlanUgcVideos", () => {
  const targets: UgcPlanTarget[] = [
    { postId: "p1", socialAccountId: "a1", channel: "x", videoSubject: "Theme A", postText: "copy 1" },
    { postId: "p2", socialAccountId: "a2", channel: "linkedin", videoSubject: "Theme B", postText: "copy 2" },
    { postId: "p3", socialAccountId: "a3", channel: "facebook", videoSubject: "Theme C", postText: "copy 3" },
  ];

  it("a render failure does NOT abort the loop — other posts still kick off", async () => {
    const calls: string[] = [];
    const startReferenceVideoRender = vi.fn(
      async (_ws: string, input: { videoSubject?: string }) => {
        calls.push(input.videoSubject ?? "");
        if (input.videoSubject === "Theme B") throw new Error("Higgsfield unreachable");
        return { jobId: "j", providerJobId: "t" };
      },
    );

    const res = await kickoffPlanUgcVideos("ws", targets, avatar, 10, "user-1", {
      startReferenceVideoRender: startReferenceVideoRender as never,
    });

    // All three were attempted; the p2 failure was isolated, not rethrown.
    expect(calls).toEqual(["Theme A", "Theme B", "Theme C"]);
    expect(res.attempted).toBe(3);
    expect(res.started).toBe(2);
    expect(res.failed).toBe(1);
  });

  it("pre-populates a Higgsfield 'present' render from the post copy + avatar", async () => {
    const startReferenceVideoRender = vi.fn(
      async (_ws: string, _input: unknown) => ({ jobId: "j", providerJobId: "t" }),
    );
    await kickoffPlanUgcVideos("ws", [targets[0]!], avatar, 10, "user-1", {
      startReferenceVideoRender: startReferenceVideoRender as never,
    });
    expect(startReferenceVideoRender).toHaveBeenCalledTimes(1);
    const [ws, input] = startReferenceVideoRender.mock.calls[0]!;
    expect(ws).toBe("ws");
    // Built by buildUgcRenderInput: present/higgsfield, the avatar pointer, the
    // post copy as the script, consent attested by the acting user.
    expect(input).toMatchObject({
      capability: "present",
      presentProvider: "higgsfield_video",
      referenceImageUrl: avatar.imageUrl,
      referenceImagePath: avatar.imagePath,
      script: "copy 1",
      videoSubject: "Theme A",
      consent: true,
      consentBy: "user-1",
      socialAccountId: "a1",
    });
  });

  it("skips a post with empty copy without consuming an attempt or quota", async () => {
    const startReferenceVideoRender = vi.fn(async () => ({ jobId: "j", providerJobId: "t" }));
    const withEmpty: UgcPlanTarget[] = [
      { postId: "p1", socialAccountId: "a1", channel: "x", videoSubject: "Theme A", postText: "   " },
      { postId: "p2", socialAccountId: "a2", channel: "x", videoSubject: "Theme B", postText: "copy 2" },
    ];
    const res = await kickoffPlanUgcVideos("ws", withEmpty, avatar, 10, "user-1", {
      startReferenceVideoRender: startReferenceVideoRender as never,
    });
    // p1 (empty) skipped → not attempted; only p2 fired.
    expect(startReferenceVideoRender).toHaveBeenCalledTimes(1);
    expect(res.attempted).toBe(1);
    expect(res.started).toBe(1);
  });

  it("caps the number of renders at the remaining quota", async () => {
    const startReferenceVideoRender = vi.fn(async () => ({ jobId: "j", providerJobId: "t" }));
    const res = await kickoffPlanUgcVideos("ws", targets, avatar, 1, "user-1", {
      startReferenceVideoRender: startReferenceVideoRender as never,
    });
    expect(startReferenceVideoRender).toHaveBeenCalledTimes(1);
    expect(res.started).toBe(1);
    expect(res.quotaExhausted).toBe(true);
  });

  it("stops early (and does not rethrow) when startReferenceVideoRender throws QuotaExceededError", async () => {
    const startReferenceVideoRender = vi.fn(
      async (_ws: string, input: { videoSubject?: string }) => {
        if (input.videoSubject === "Theme B") throw new QuotaExceededError({} as never);
        return { jobId: "j", providerJobId: "t" };
      },
    );
    const res = await kickoffPlanUgcVideos("ws", targets, avatar, 10, "user-1", {
      startReferenceVideoRender: startReferenceVideoRender as never,
    });
    // p1 started, p2 tripped quota → loop stops, p3 never attempted.
    expect(startReferenceVideoRender).toHaveBeenCalledTimes(2);
    expect(res.started).toBe(1);
    expect(res.quotaExhausted).toBe(true);
  });

  it("does nothing when remaining quota is 0", async () => {
    const startReferenceVideoRender = vi.fn(async () => ({ jobId: "j", providerJobId: "t" }));
    const res = await kickoffPlanUgcVideos("ws", targets, avatar, 0, "user-1", {
      startReferenceVideoRender: startReferenceVideoRender as never,
    });
    expect(startReferenceVideoRender).not.toHaveBeenCalled();
    expect(res.started).toBe(0);
  });
});
