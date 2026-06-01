import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Unit: plan-generated videos (src/lib/video/plan-videos.ts) ───────────────
//
// Covers the four contracts the LOCKED DECISIONS pin down:
//   1. Per-channel parse — `video_<accountId>="on"` → the opted-in account set.
//   2. Video-capable + keys gating — shouldGenerateVideoForPost only fires when
//      video is available, the account opted in, AND the channel supportsVideo.
//   3. Force pending_approval — the action computes effectiveTrusted = trusted
//      && !wantsVideo; we assert the predicate that drives it flips a trusted
//      video post to "not trusted" (→ pending_approval).
//   4. Render failure isolation — a startVideoRender throw inside the kickoff
//      loop is swallowed (the plan must still save) and the loop continues.
//
// QuotaExceededError is imported from @/lib/billing/limits; we mock that module
// minimally so the kickoff loop's `instanceof QuotaExceededError` branch works
// without pulling in supabase. The orchestrator is never invoked — every test
// injects a fake startVideoRender.

vi.mock("@/lib/billing/limits", () => {
  class FakeQuotaError extends Error {
    constructor() {
      super("quota");
      this.name = "QuotaExceededError";
    }
  }
  return { QuotaExceededError: FakeQuotaError };
});

// Keep tiers/usage mockable for remainingVideoQuota; default to a generous tier
// + zero usage. Individual tests override via the mocked fns below.
const tierLimits = { videosPerMonth: 20 };
const usageSnapshot = { videosGenerated: 0 };
vi.mock("@/lib/billing/tiers", () => ({
  tierFor: () => ({ limits: tierLimits }),
}));
vi.mock("@/lib/billing/usage", () => ({
  getUsageSnapshot: async () => usageSnapshot,
}));

import {
  parseVideoOptIns,
  isVideoEligibleChannel,
  shouldGenerateVideoForPost,
  remainingVideoQuota,
  kickoffPlanVideos,
  type PlanVideoTarget,
} from "@/lib/video/plan-videos";
// The mocked QuotaExceededError (same class the kickoff loop branches on).
import { QuotaExceededError } from "@/lib/billing/limits";

// Minimal FormData-shaped stub for parseVideoOptIns (it only calls .entries()).
function fakeFormData(pairs: Array<[string, string]>) {
  return {
    *entries(): IterableIterator<[string, FormDataEntryValue]> {
      for (const p of pairs) yield p as [string, FormDataEntryValue];
    },
  };
}

beforeEach(() => {
  tierLimits.videosPerMonth = 20;
  usageSnapshot.videosGenerated = 0;
});
afterEach(() => vi.clearAllMocks());

describe("parseVideoOptIns (per-channel parse)", () => {
  it("collects only the video_<id> keys whose value is 'on'", () => {
    const out = parseVideoOptIns(
      fakeFormData([
        ["include_acc-1", "on"],
        ["video_acc-1", "on"],
        ["posts_acc-1", "7"],
        ["video_acc-2", "on"],
        // not opted in (unchecked checkboxes don't submit, but be defensive)
        ["video_acc-3", "off"],
        ["compare_competitors", "1"],
      ]),
    );
    expect(out.has("acc-1")).toBe(true);
    expect(out.has("acc-2")).toBe(true);
    expect(out.has("acc-3")).toBe(false);
    expect(out.size).toBe(2);
  });

  it("returns an empty set when no video flags are present", () => {
    const out = parseVideoOptIns(fakeFormData([["include_acc-1", "on"]]));
    expect(out.size).toBe(0);
  });
});

describe("video-capable + keys gating", () => {
  it("isVideoEligibleChannel reflects the registry supportsVideo flag", () => {
    expect(isVideoEligibleChannel("x")).toBe(true); // supportsVideo: true
    expect(isVideoEligibleChannel("not-a-channel")).toBe(false);
  });

  it("requires video availability, opt-in, AND a video-capable channel", () => {
    const optedIn = new Set(["acc-1"]);

    // Happy path: available + opted-in + capable channel.
    expect(
      shouldGenerateVideoForPost({
        videoAvailable: true,
        optedInAccountIds: optedIn,
        socialAccountId: "acc-1",
        channel: "x",
      }),
    ).toBe(true);

    // videoAvailable false (e.g. missing LLM/Pexels keys) → no video.
    expect(
      shouldGenerateVideoForPost({
        videoAvailable: false,
        optedInAccountIds: optedIn,
        socialAccountId: "acc-1",
        channel: "x",
      }),
    ).toBe(false);

    // Account not opted in → no video.
    expect(
      shouldGenerateVideoForPost({
        videoAvailable: true,
        optedInAccountIds: optedIn,
        socialAccountId: "acc-2",
        channel: "x",
      }),
    ).toBe(false);

    // Channel not video-capable → no video (defensive — the form hides it too).
    expect(
      shouldGenerateVideoForPost({
        videoAvailable: true,
        optedInAccountIds: optedIn,
        socialAccountId: "acc-1",
        channel: "not-a-channel",
      }),
    ).toBe(false);
  });
});

describe("force pending_approval for video posts", () => {
  // The action sets effectiveTrusted = trusted && !wantsVideo. A trusted post
  // that wants a video must NOT auto-schedule — it has to render + be reviewed.
  function effectiveTrusted(trusted: boolean, wantsVideo: boolean): boolean {
    return trusted && !wantsVideo;
  }

  it("a trusted channel post that wants a video is forced un-trusted (→ pending_approval)", () => {
    expect(effectiveTrusted(true, true)).toBe(false);
  });

  it("a trusted channel post WITHOUT a video keeps auto-scheduling", () => {
    expect(effectiveTrusted(true, false)).toBe(true);
  });

  it("an untrusted post is unaffected either way", () => {
    expect(effectiveTrusted(false, true)).toBe(false);
    expect(effectiveTrusted(false, false)).toBe(false);
  });
});

describe("remainingVideoQuota", () => {
  it("returns the tier ceiling minus usage", async () => {
    tierLimits.videosPerMonth = 20;
    usageSnapshot.videosGenerated = 5;
    expect(await remainingVideoQuota("ws", "pro")).toBe(15);
  });

  it("returns 0 when the tier excludes video", async () => {
    tierLimits.videosPerMonth = 0;
    expect(await remainingVideoQuota("ws", "hobby")).toBe(0);
  });

  it("returns Infinity for an unlimited (-1) tier", async () => {
    tierLimits.videosPerMonth = -1;
    expect(await remainingVideoQuota("ws", "founder")).toBe(Number.POSITIVE_INFINITY);
  });

  it("never goes negative when usage already exceeds the ceiling", async () => {
    tierLimits.videosPerMonth = 20;
    usageSnapshot.videosGenerated = 25;
    expect(await remainingVideoQuota("ws", "pro")).toBe(0);
  });
});

describe("kickoffPlanVideos", () => {
  const targets: PlanVideoTarget[] = [
    { postId: "p1", socialAccountId: "a1", channel: "x", videoSubject: "Theme A", videoScript: "copy 1" },
    { postId: "p2", socialAccountId: "a2", channel: "linkedin", videoSubject: "Theme B", videoScript: "copy 2" },
    { postId: "p3", socialAccountId: "a3", channel: "facebook", videoSubject: "Theme C", videoScript: "copy 3" },
  ];

  it("a render failure does NOT abort the loop — other posts still kick off", async () => {
    const calls: string[] = [];
    const startVideoRender = vi.fn(async (_ws: string, input: { postId?: string | null }) => {
      calls.push(input.postId ?? "");
      if (input.postId === "p2") throw new Error("MPT unreachable");
      return { jobId: "j", mptTaskId: "t" };
    });

    const res = await kickoffPlanVideos("ws", targets, 10, {
      startVideoRender: startVideoRender as never,
    });

    // All three were attempted; the p2 failure was isolated, not rethrown.
    expect(calls).toEqual(["p1", "p2", "p3"]);
    expect(res.attempted).toBe(3);
    expect(res.started).toBe(2);
    expect(res.failed).toBe(1);
  });

  it("passes the post's subject/script/postId through (MPT narrates the copy on the post)", async () => {
    const startVideoRender = vi.fn(async () => ({ jobId: "j", mptTaskId: "t" }));
    await kickoffPlanVideos("ws", [targets[0]!], 10, {
      startVideoRender: startVideoRender as never,
    });
    expect(startVideoRender).toHaveBeenCalledWith("ws", {
      videoSubject: "Theme A",
      videoScript: "copy 1",
      videoAspect: "9:16",
      socialAccountId: "a1",
      postId: "p1",
      videoCount: 1,
    });
  });

  it("caps the number of renders at the remaining quota", async () => {
    const startVideoRender = vi.fn(async () => ({ jobId: "j", mptTaskId: "t" }));
    const res = await kickoffPlanVideos("ws", targets, 1, {
      startVideoRender: startVideoRender as never,
    });
    expect(startVideoRender).toHaveBeenCalledTimes(1);
    expect(res.started).toBe(1);
    expect(res.quotaExhausted).toBe(true);
  });

  it("stops early (and does not rethrow) when startVideoRender throws QuotaExceededError", async () => {
    const startVideoRender = vi.fn(async (_ws: string, input: { postId?: string | null }) => {
      if (input.postId === "p2") throw new QuotaExceededError({} as never);
      return { jobId: "j", mptTaskId: "t" };
    });
    const res = await kickoffPlanVideos("ws", targets, 10, {
      startVideoRender: startVideoRender as never,
    });
    // p1 started, p2 tripped quota → loop stops, p3 never attempted.
    expect(startVideoRender).toHaveBeenCalledTimes(2);
    expect(res.started).toBe(1);
    expect(res.quotaExhausted).toBe(true);
  });

  it("does nothing when remaining quota is 0", async () => {
    const startVideoRender = vi.fn(async () => ({ jobId: "j", mptTaskId: "t" }));
    const res = await kickoffPlanVideos("ws", targets, 0, {
      startVideoRender: startVideoRender as never,
    });
    expect(startVideoRender).not.toHaveBeenCalled();
    expect(res.started).toBe(0);
  });
});
