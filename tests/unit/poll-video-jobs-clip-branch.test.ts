import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// ── Unit: poll-video-jobs user_clip branch (cron route) ──────────────────────
//
// Drives the cron handler with mocked deps so NO MPT / DB call is live. Focus:
//   1. A params.kind === "user_clip" job pulls ITS OWN <label>.mp4 from the
//      (possibly shared) task's videos[], uploads it, attaches a draft, markReady.
//   2. A COMPLETE task whose videos[] is missing this clip's label → markFailed.
//   3. FAILED state → markFailed; still-processing → processing.
//   4. Cleanup: deleteTask + source removal only fire when no sibling job is
//      still processing the same task; held back when a sibling remains.

let mptConfigured = true;
let referenceVideoEnabled = false;
vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ CRON_SECRET: "secret-cron-key-1234" }),
  mptConfigured: () => mptConfigured,
  referenceVideoEnabled: () => referenceVideoEnabled,
}));

// Supabase service: storage upload/remove + a `video_jobs` count head query +
// an `uploaded_videos` storage_path lookup. The from() router branches on table.
const uploadMock = vi.fn().mockResolvedValue({ error: null });
const removeMock = vi.fn().mockResolvedValue({ error: null });
let siblingProcessingCount = 0; // how many siblings still processing the task
const fromRouter = (table: string) => {
  if (table === "video_jobs") {
    // .select("id", {count, head}).eq().eq() → { count }
    return {
      select: () => ({
        eq: () => ({ eq: () => ({ count: siblingProcessingCount }) }),
      }),
    };
  }
  if (table === "uploaded_videos") {
    return {
      select: () => ({
        eq: () => ({ maybeSingle: () => ({ data: { storage_path: "ws-1/uv-1/source.mp4" } }) }),
      }),
    };
  }
  // social_accounts (attachDraftPost) — no destination → null.
  return { select: () => ({ eq: () => ({ maybeSingle: () => ({ data: null }) }) }) };
};
const supabaseService = () => ({
  storage: { from: () => ({ upload: uploadMock, remove: removeMock }) },
  from: fromRouter,
});
vi.mock("@/lib/supabase/service", () => ({ supabaseService: () => supabaseService() }));

const getTask = vi.fn();
const downloadVideo = vi.fn();
const deleteTask = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/video/mpt-client", () => ({
  getTask: (...a: unknown[]) => getTask(...a),
  downloadVideo: (...a: unknown[]) => downloadVideo(...a),
  deleteTask: (...a: unknown[]) => deleteTask(...a),
  fileNameFromVideoPath: (p: string) => p.split("/").pop() ?? p,
  MPT_STATE_COMPLETE: 1,
  MPT_STATE_FAILED: -1,
}));

const listProcessing = vi.fn();
const updateProgress = vi.fn().mockResolvedValue(undefined);
const markReady = vi.fn().mockResolvedValue(undefined);
const markFailed = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/video/jobs", () => ({
  listProcessing: (...a: unknown[]) => listProcessing(...a),
  updateProgress: (...a: unknown[]) => updateProgress(...a),
  markReady: (...a: unknown[]) => markReady(...a),
  markFailed: (...a: unknown[]) => markFailed(...a),
}));

// Reference branch deps — present but unused by clip jobs.
vi.mock("@/lib/video/byo-keys", () => ({ getWorkspaceKeys: vi.fn() }));
vi.mock("@/lib/video/reference/stub-provider", () => ({
  getReferenceVideoProvider: () => ({ poll: vi.fn(), fetchBytes: vi.fn() }),
}));

import { POST } from "@/app/api/cron/poll-video-jobs/route";

function clipJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-c1",
    workspace_id: "ws-1",
    social_account_id: null,
    post_id: null,
    status: "processing",
    mpt_task_id: "clip-task-9",
    params: { kind: "user_clip", label: "hook", uploadedVideoId: "uv-1" },
    progress: 0,
    storage_path: null,
    failure_reason: null,
    reference_image_path: null,
    uploaded_video_id: "uv-1",
    clip_label: "hook",
    clip_start_ms: 0,
    clip_end_ms: 4000,
    burn_captions: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function authedReq(): NextRequest {
  return new NextRequest("https://app.test/api/cron/poll-video-jobs", {
    method: "POST",
    headers: { authorization: "Bearer secret-cron-key-1234" },
  });
}

beforeEach(() => {
  mptConfigured = true;
  referenceVideoEnabled = false;
  siblingProcessingCount = 0;
});
afterEach(() => vi.clearAllMocks());

describe("user_clip branch", () => {
  it("downloads this clip's <label>.mp4, uploads it, markReady, cleans up when last sibling", async () => {
    listProcessing.mockResolvedValue([clipJob()]);
    getTask.mockResolvedValue({
      data: { state: 1, progress: 100, videos: ["clip-task-9/hook.mp4", "clip-task-9/cta.mp4"] },
    });
    downloadVideo.mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));

    const res = await POST(authedReq());
    const body = await res.json();

    // Pulled the clip matching THIS job's label, not a sibling's.
    expect(downloadVideo).toHaveBeenCalledWith("clip-task-9", "hook.mp4");
    expect(uploadMock).toHaveBeenCalled();
    const [path] = uploadMock.mock.calls[0] as [string];
    expect(path).toBe("ws-1/job-c1/hook.mp4");
    expect(markReady).toHaveBeenCalledWith("job-c1", "ws-1/job-c1/hook.mp4", null);
    // No siblings processing → cleanup fired.
    expect(deleteTask).toHaveBeenCalledWith("clip-task-9");
    expect(removeMock).toHaveBeenCalledWith(["ws-1/uv-1/source.mp4"]);
    expect(body.results[0]).toMatchObject({ id: "job-c1", status: "ready" });
  });

  it("holds back cleanup while a sibling clip is still processing the task", async () => {
    siblingProcessingCount = 1;
    listProcessing.mockResolvedValue([clipJob()]);
    getTask.mockResolvedValue({
      data: { state: 1, progress: 100, videos: ["clip-task-9/hook.mp4"] },
    });
    downloadVideo.mockResolvedValue(new Response(new Uint8Array([9])));

    await POST(authedReq());

    expect(markReady).toHaveBeenCalled();
    expect(deleteTask).not.toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
  });

  it("marks failed when the complete task is missing this clip's label", async () => {
    listProcessing.mockResolvedValue([clipJob()]);
    getTask.mockResolvedValue({
      data: { state: 1, progress: 100, videos: ["clip-task-9/cta.mp4"] },
    });

    const res = await POST(authedReq());
    const body = await res.json();

    expect(markFailed).toHaveBeenCalled();
    expect(downloadVideo).not.toHaveBeenCalled();
    expect(body.results[0].status).toBe("failed");
  });

  it("marks failed on MPT FAILED state", async () => {
    listProcessing.mockResolvedValue([clipJob()]);
    getTask.mockResolvedValue({ data: { state: -1 } });

    const res = await POST(authedReq());
    const body = await res.json();

    expect(markFailed).toHaveBeenCalled();
    expect(body.results[0].status).toBe("failed");
  });

  it("frees the source + task when the LAST sibling clip FAILS (cleanup on the failed path)", async () => {
    // No sibling still processing → this failed clip is the last to finish, so
    // the raw source object + MPT task must be freed even though it didn't succeed.
    siblingProcessingCount = 0;
    listProcessing.mockResolvedValue([clipJob()]);
    getTask.mockResolvedValue({ data: { state: -1 } });

    const res = await POST(authedReq());
    const body = await res.json();

    expect(markFailed).toHaveBeenCalled();
    expect(deleteTask).toHaveBeenCalledWith("clip-task-9");
    expect(removeMock).toHaveBeenCalledWith(["ws-1/uv-1/source.mp4"]);
    expect(body.results[0].status).toBe("failed");
  });

  it("holds back cleanup on a FAILED clip while a sibling is still processing", async () => {
    siblingProcessingCount = 1;
    listProcessing.mockResolvedValue([clipJob()]);
    getTask.mockResolvedValue({ data: { state: -1 } });

    await POST(authedReq());

    expect(markFailed).toHaveBeenCalled();
    expect(deleteTask).not.toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
  });

  it("leaves a still-rendering clip job as processing", async () => {
    listProcessing.mockResolvedValue([clipJob()]);
    getTask.mockResolvedValue({ data: { state: 4, progress: 30 } });

    const res = await POST(authedReq());
    const body = await res.json();

    expect(markReady).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
    expect(body.results[0].status).toBe("processing");
  });
});
