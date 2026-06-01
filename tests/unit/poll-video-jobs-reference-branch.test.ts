import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// ── Unit: poll-video-jobs reference-image branch (cron route) ────────────────
//
// Drives the cron handler with mocked deps so NO MPT / fal / DB call is live.
// Focus:
//   1. A params.kind === "reference_image" job routes to the fal adapter
//      (poll/fetchBytes) and NEVER calls the MPT getTask (the MPT path is
//      untouched for these jobs).
//   2. A ready poll → upload + markReady.
//   3. The top gate no longer early-returns when MPT is unconfigured but the
//      reference flag is on.

let mptConfigured = true;
let referenceVideoEnabled = true;
vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ CRON_SECRET: "secret-cron-key-1234" }),
  mptConfigured: () => mptConfigured,
  referenceVideoEnabled: () => referenceVideoEnabled,
}));

// In-memory storage stub.
const uploadMock = vi.fn().mockResolvedValue({ error: null });
const supabaseService = () => ({
  storage: { from: () => ({ upload: uploadMock }) },
  from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: () => ({ data: null }) }) }),
  }),
});
vi.mock("@/lib/supabase/service", () => ({ supabaseService: () => supabaseService() }));

// MPT client — getTask MUST NOT be called for reference jobs.
const getTask = vi.fn();
vi.mock("@/lib/video/mpt-client", () => ({
  getTask: (...a: unknown[]) => getTask(...a),
  downloadVideo: vi.fn(),
  deleteTask: vi.fn(),
  fileNameFromVideoPath: vi.fn(),
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

const getWorkspaceKeys = vi.fn().mockResolvedValue({ fal_video: { api_key: "fal-k" } });
vi.mock("@/lib/video/byo-keys", () => ({
  getWorkspaceKeys: (...a: unknown[]) => getWorkspaceKeys(...a),
}));

const poll = vi.fn();
const fetchBytes = vi.fn();
vi.mock("@/lib/video/reference/stub-provider", () => ({
  getReferenceVideoProvider: () => ({ name: "fal_video", poll, fetchBytes }),
}));

import { POST } from "@/app/api/cron/poll-video-jobs/route";

function refJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-r1",
    workspace_id: "ws-1",
    social_account_id: null,
    post_id: null,
    status: "processing",
    mpt_task_id: "req-9", // holds the fal request id for reference jobs
    params: { kind: "reference_image", provider: "fal_video", video_subject: "me" },
    progress: 0,
    storage_path: null,
    failure_reason: null,
    reference_image_path: "ws-1/u1/reference.jpg",
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
  referenceVideoEnabled = true;
});
afterEach(() => vi.clearAllMocks());

describe("reference-image branch", () => {
  it("routes a reference_image job to the fal adapter and never calls MPT getTask", async () => {
    listProcessing.mockResolvedValue([refJob()]);
    poll.mockResolvedValue({ status: "ready", videoUrl: "https://cdn.fal/out.mp4", progress: 100 });
    fetchBytes.mockResolvedValue({ bytes: new Uint8Array([1, 2]), contentType: "video/mp4" });

    const res = await POST(authedReq());
    const body = await res.json();

    expect(getTask).not.toHaveBeenCalled();
    expect(poll).toHaveBeenCalledWith("req-9", "fal-k");
    expect(fetchBytes).toHaveBeenCalledWith("https://cdn.fal/out.mp4", "fal-k");
    expect(uploadMock).toHaveBeenCalled();
    expect(markReady).toHaveBeenCalledWith("job-r1", "ws-1/job-r1/final.mp4", null);
    expect(body.results[0]).toMatchObject({ id: "job-r1", status: "ready" });
  });

  it("marks a reference job failed when the provider reports failure", async () => {
    listProcessing.mockResolvedValue([refJob()]);
    poll.mockResolvedValue({ status: "failed", failureReason: "content policy" });

    const res = await POST(authedReq());
    const body = await res.json();

    expect(markFailed).toHaveBeenCalledWith("job-r1", "content policy");
    expect(fetchBytes).not.toHaveBeenCalled();
    expect(body.results[0].status).toBe("failed");
  });

  it("leaves a still-rendering reference job as processing", async () => {
    listProcessing.mockResolvedValue([refJob()]);
    poll.mockResolvedValue({ status: "processing" });

    const res = await POST(authedReq());
    const body = await res.json();

    expect(markReady).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
    expect(body.results[0].status).toBe("processing");
  });
});

describe("top-of-handler gate", () => {
  it("does NOT early-return when MPT is unconfigured but the reference flag is on", async () => {
    mptConfigured = false;
    referenceVideoEnabled = true;
    listProcessing.mockResolvedValue([refJob()]);
    poll.mockResolvedValue({ status: "processing" });

    const res = await POST(authedReq());
    const body = await res.json();

    // It reached the loop (checked the job) rather than skipping.
    expect(body.skipped).toBeUndefined();
    expect(body.checked).toBe(1);
  });

  it("early-returns when NEITHER pipeline is configured", async () => {
    mptConfigured = false;
    referenceVideoEnabled = false;

    const res = await POST(authedReq());
    const body = await res.json();

    expect(body.skipped).toBe("no-video-pipeline-configured");
    expect(listProcessing).not.toHaveBeenCalled();
  });
});
