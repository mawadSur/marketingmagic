import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Unit: clip-cut orchestration (src/lib/video/uploads/clip-orchestrator.ts) ─
//
// All deps mocked so NO MPT / Supabase / billing call is live. Focus:
//   1. Happy path: quota → sign source url → one job per clip → ONE MPT clip
//      task → markProcessing every job with the shared task id → meter N units.
//   2. Per-clip captions: a burnCaptions clip with transcript segments sends a
//      sliced, re-based SRT; a no-captions clip sends none.
//   3. Validation: flag off, MPT unconfigured, empty clips, bad window, bad
//      label, duplicate label, too many clips.
//   4. Source guards: missing / not-ready source.
//   5. MPT failure fails every minted job and rethrows.

let userVideoUploadEnabled = true;
let mptConfigured = true;
vi.mock("@/lib/env", () => ({
  userVideoUploadEnabled: () => userVideoUploadEnabled,
  mptConfigured: () => mptConfigured,
}));

const assertWithinVideoQuota = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/billing/limits", () => ({
  assertWithinVideoQuota: (...a: unknown[]) => assertWithinVideoQuota(...a),
}));
const incrementVideosGenerated = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/billing/usage", () => ({
  incrementVideosGenerated: (...a: unknown[]) => incrementVideosGenerated(...a),
}));

// jobs.ts — record createJob inputs; hand back incrementing ids.
let jobSeq = 0;
const createJob = vi.fn(async (input: Record<string, unknown>) => ({
  id: `job-${++jobSeq}`,
  label: input.clipLabel,
}));
const markProcessing = vi.fn().mockResolvedValue(undefined);
const markFailed = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/video/jobs", () => ({
  createJob: (input: Record<string, unknown>) => createJob(input),
  markProcessing: (...a: unknown[]) => markProcessing(...a),
  markFailed: (...a: unknown[]) => markFailed(...a),
}));

const createClipTask = vi.fn();
vi.mock("@/lib/video/mpt-client", () => ({
  createClipTask: (...a: unknown[]) => createClipTask(...a),
}));

// Supabase service: source row lookup + signed url. Mutable so tests can vary.
const sourceRow = {
  data: { id: "uv-1", workspace_id: "ws-1", storage_path: "ws-1/uv-1/source.mp4", status: "ready" },
  error: null as { message: string } | null,
};
const signed = {
  data: { signedUrl: "https://supa/source.mp4?sig=abc" } as { signedUrl: string } | null,
  error: null as { message: string } | null,
};
const createSignedUrl = vi.fn(async () => signed);
const supabaseService = () => ({
  from: () => ({
    select: () => ({
      eq: () => ({ eq: () => ({ maybeSingle: async () => sourceRow }) }),
    }),
  }),
  storage: { from: () => ({ createSignedUrl }) },
});
vi.mock("@/lib/supabase/service", () => ({ supabaseService: () => supabaseService() }));

import { startClipJobs, ClipJobError } from "@/lib/video/uploads/clip-orchestrator";
import type { TranscriptSegment } from "@/lib/video/uploads/types";

const SEGMENTS: TranscriptSegment[] = [
  { startMs: 0, endMs: 2000, text: "hello world" },
  { startMs: 2000, endMs: 4000, text: "second line" },
  { startMs: 12000, endMs: 14000, text: "the call to action" },
];

beforeEach(() => {
  userVideoUploadEnabled = true;
  mptConfigured = true;
  jobSeq = 0;
  sourceRow.data = {
    id: "uv-1",
    workspace_id: "ws-1",
    storage_path: "ws-1/uv-1/source.mp4",
    status: "ready",
  };
  sourceRow.error = null;
  signed.data = { signedUrl: "https://supa/source.mp4?sig=abc" };
  signed.error = null;
  createClipTask.mockResolvedValue({ data: { task_id: "clip-task-9" } });
});
afterEach(() => vi.clearAllMocks());

describe("startClipJobs: happy path", () => {
  it("quota → signs source → one job per clip → one MPT task → markProcessing all → meter N", async () => {
    const res = await startClipJobs("ws-1", "uv-1", {
      clips: [
        { label: "hook", startMs: 0, endMs: 4000, burnCaptions: true },
        { label: "cta", startMs: 12000, endMs: 14000, burnCaptions: false },
      ],
      aspect: "9:16",
      transcriptSegments: SEGMENTS,
    });

    // Quota gated for all clips up front.
    expect(assertWithinVideoQuota).toHaveBeenCalledWith("ws-1", 2);

    // Signed a GET url for the source object.
    expect(createSignedUrl).toHaveBeenCalledWith("ws-1/uv-1/source.mp4", expect.any(Number));

    // One job per clip, each stamped with clip cols + params.kind.
    expect(createJob).toHaveBeenCalledTimes(2);
    const firstJob = createJob.mock.calls[0][0] as Record<string, unknown>;
    expect(firstJob).toMatchObject({
      workspaceId: "ws-1",
      uploadedVideoId: "uv-1",
      clipLabel: "hook",
      clipStartMs: 0,
      clipEndMs: 4000,
      burnCaptions: true,
    });
    expect((firstJob.params as Record<string, unknown>).kind).toBe("user_clip");

    // ONE MPT clip task for the whole batch.
    expect(createClipTask).toHaveBeenCalledTimes(1);
    const clipArg = createClipTask.mock.calls[0][0] as Record<string, unknown>;
    expect(clipArg.source_url).toBe("https://supa/source.mp4?sig=abc");
    expect(clipArg.aspect).toBe("9:16");

    // Every job flipped to processing with the shared task id.
    expect(markProcessing).toHaveBeenCalledWith("job-1", "clip-task-9");
    expect(markProcessing).toHaveBeenCalledWith("job-2", "clip-task-9");

    // Metered once MPT accepted, one unit per clip.
    expect(incrementVideosGenerated).toHaveBeenCalledWith("ws-1", 2);

    expect(res.mptTaskId).toBe("clip-task-9");
    expect(res.jobs).toEqual([
      { jobId: "job-1", label: "hook" },
      { jobId: "job-2", label: "cta" },
    ]);
  });

  it("sends a sliced+re-based SRT for a burnCaptions clip and none for the rest", async () => {
    await startClipJobs("ws-1", "uv-1", {
      clips: [
        { label: "hook", startMs: 0, endMs: 4000, burnCaptions: true },
        { label: "cta", startMs: 12000, endMs: 14000, burnCaptions: false },
      ],
      transcriptSegments: SEGMENTS,
    });

    const clipArg = createClipTask.mock.calls[0][0] as { clips: Array<Record<string, unknown>> };
    const [hook, cta] = clipArg.clips;
    // hook burns captions: SRT present, re-based to t=0 (starts at 00:00:00,000).
    expect(hook.burn_captions).toBe(true);
    expect(typeof hook.subtitles_srt).toBe("string");
    expect(hook.subtitles_srt as string).toContain("00:00:00,000 -->");
    // cta has no captions requested → no srt + burn false.
    expect(cta.burn_captions).toBe(false);
    expect(cta.subtitles_srt).toBeUndefined();
  });

  it("does NOT burn captions when burnCaptions is set but there are no segments", async () => {
    await startClipJobs("ws-1", "uv-1", {
      clips: [{ label: "hook", startMs: 0, endMs: 4000, burnCaptions: true }],
      transcriptSegments: [],
    });
    const clipArg = createClipTask.mock.calls[0][0] as { clips: Array<Record<string, unknown>> };
    expect(clipArg.clips[0].burn_captions).toBe(false);
    expect(clipArg.clips[0].subtitles_srt).toBeUndefined();
    // The job's column reflects the effective (false) value, not the request.
    const job = createJob.mock.calls[0][0] as Record<string, unknown>;
    expect(job.burnCaptions).toBe(false);
  });
});

describe("startClipJobs: validation", () => {
  const goodClip = { label: "hook", startMs: 0, endMs: 4000, burnCaptions: false };

  it("throws when the feature flag is off (no DB/MPT)", async () => {
    userVideoUploadEnabled = false;
    await expect(startClipJobs("ws-1", "uv-1", { clips: [goodClip] })).rejects.toBeInstanceOf(
      ClipJobError,
    );
    expect(assertWithinVideoQuota).not.toHaveBeenCalled();
    expect(createJob).not.toHaveBeenCalled();
  });

  it("throws when MPT is unconfigured", async () => {
    mptConfigured = false;
    await expect(startClipJobs("ws-1", "uv-1", { clips: [goodClip] })).rejects.toBeInstanceOf(
      ClipJobError,
    );
  });

  it("throws on no clips", async () => {
    await expect(startClipJobs("ws-1", "uv-1", { clips: [] })).rejects.toBeInstanceOf(ClipJobError);
  });

  it("throws on too many clips", async () => {
    const many = Array.from({ length: 21 }, (_, i) => ({
      label: `c${i}`,
      startMs: 0,
      endMs: 1000,
      burnCaptions: false,
    }));
    await expect(startClipJobs("ws-1", "uv-1", { clips: many })).rejects.toBeInstanceOf(ClipJobError);
  });

  it("throws on an invalid window (end <= start)", async () => {
    await expect(
      startClipJobs("ws-1", "uv-1", {
        clips: [{ label: "x", startMs: 5000, endMs: 5000, burnCaptions: false }],
      }),
    ).rejects.toBeInstanceOf(ClipJobError);
  });

  it("throws on an unsafe label", async () => {
    await expect(
      startClipJobs("ws-1", "uv-1", {
        clips: [{ label: "../etc", startMs: 0, endMs: 1000, burnCaptions: false }],
      }),
    ).rejects.toBeInstanceOf(ClipJobError);
  });

  it("throws on duplicate labels", async () => {
    await expect(
      startClipJobs("ws-1", "uv-1", {
        clips: [
          { label: "dup", startMs: 0, endMs: 1000, burnCaptions: false },
          { label: "dup", startMs: 2000, endMs: 3000, burnCaptions: false },
        ],
      }),
    ).rejects.toBeInstanceOf(ClipJobError);
  });
});

describe("startClipJobs: source guards", () => {
  it("throws when the source row is missing", async () => {
    sourceRow.data = null as never;
    await expect(
      startClipJobs("ws-1", "uv-1", {
        clips: [{ label: "x", startMs: 0, endMs: 1000, burnCaptions: false }],
      }),
    ).rejects.toBeInstanceOf(ClipJobError);
  });

  it("throws when the source is not ready", async () => {
    sourceRow.data = { ...sourceRow.data, status: "uploading" } as never;
    await expect(
      startClipJobs("ws-1", "uv-1", {
        clips: [{ label: "x", startMs: 0, endMs: 1000, burnCaptions: false }],
      }),
    ).rejects.toBeInstanceOf(ClipJobError);
  });
});

describe("startClipJobs: MPT failure", () => {
  it("fails every minted job and rethrows when the MPT POST throws", async () => {
    createClipTask.mockRejectedValue(new Error("queue full"));
    await expect(
      startClipJobs("ws-1", "uv-1", {
        clips: [
          { label: "a", startMs: 0, endMs: 1000, burnCaptions: false },
          { label: "b", startMs: 2000, endMs: 3000, burnCaptions: false },
        ],
      }),
    ).rejects.toBeInstanceOf(ClipJobError);

    expect(markFailed).toHaveBeenCalledWith("job-1", "queue full");
    expect(markFailed).toHaveBeenCalledWith("job-2", "queue full");
    expect(markProcessing).not.toHaveBeenCalled();
    expect(incrementVideosGenerated).not.toHaveBeenCalled();
  });
});
