import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceKeys } from "@/lib/video/byo-keys";

// ── Integration: startVideoRender orchestration (src/lib/video/orchestrator.ts)
//
// Every collaborator is mocked so the test asserts the orchestration contract
// in isolation:
//   - quota is checked BEFORE the MPT call (so a rejected render never enqueues)
//   - the decrypted BYO keys map correctly into the MPT renderParams
//   - an MPT throw → markFailed(jobId, reason) + VideoRenderError (not raw err)
//   - the render is metered (incrementVideosGenerated) only AFTER MPT accepts

const mptConfigured = vi.fn().mockReturnValue(true);
vi.mock("@/lib/env", () => ({
  mptConfigured: () => mptConfigured(),
}));

// Brand styling is additive; an un-branded workspace must leave the subject
// unchanged. Mock the loader to an empty style so these tests assert the
// existing (un-branded) MPT renderParams contract without touching the DB.
// The empty style is inlined inside the factory because vi.mock is hoisted
// above any top-level const (which would be a TDZ ReferenceError).
vi.mock("@/lib/brand/load", () => {
  const empty = { colors: [], visualTone: null, voiceHint: null, hasLogo: false, subjectContext: null };
  return { EMPTY_BRAND_STYLE: empty, loadBrandStyle: vi.fn().mockResolvedValue(empty) };
});

const assertWithinVideoQuota = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/billing/limits", () => ({
  assertWithinVideoQuota: (...a: unknown[]) => assertWithinVideoQuota(...a),
}));

const incrementVideosGenerated = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/billing/usage", () => ({
  incrementVideosGenerated: (...a: unknown[]) => incrementVideosGenerated(...a),
}));

const KEYS: WorkspaceKeys = {
  llm: {
    provider: "deepseek",
    api_key: "sk-deepseek-byo",
    model_name: "deepseek-chat",
    base_url: "https://api.deepseek.com",
  },
  pexels: { api_keys: ["pexels-byo-a", "pexels-byo-b"] },
};
const getWorkspaceKeys = vi.fn<() => Promise<WorkspaceKeys>>().mockResolvedValue(KEYS);
vi.mock("@/lib/video/byo-keys", () => ({
  getWorkspaceKeys: () => getWorkspaceKeys(),
}));

const createJob = vi.fn().mockResolvedValue({ id: "job-1" });
const markProcessing = vi.fn().mockResolvedValue(undefined);
const markFailed = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/video/jobs", () => ({
  createJob: (...a: unknown[]) => createJob(...a),
  markProcessing: (...a: unknown[]) => markProcessing(...a),
  markFailed: (...a: unknown[]) => markFailed(...a),
}));

const createRenderJob = vi.fn().mockResolvedValue({ data: { task_id: "mpt-task-77" } });
vi.mock("@/lib/video/mpt-client", () => ({
  createRenderJob: (...a: unknown[]) => createRenderJob(...a),
}));

import { startVideoRender, VideoRenderError } from "@/lib/video/orchestrator";
import { loadBrandStyle } from "@/lib/brand/load";

const loadBrandStyleMock = vi.mocked(loadBrandStyle);

const WS = "ws-1";

beforeEach(() => {
  mptConfigured.mockReturnValue(true);
  assertWithinVideoQuota.mockResolvedValue(undefined);
  getWorkspaceKeys.mockResolvedValue(KEYS);
  createJob.mockResolvedValue({ id: "job-1" });
  createRenderJob.mockResolvedValue({ data: { task_id: "mpt-task-77" } });
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("startVideoRender: happy path", () => {
  it("returns the job id + MPT task id and meters the render", async () => {
    const res = await startVideoRender(WS, { videoSubject: "Launch recap", videoCount: 1 });
    expect(res).toEqual({ jobId: "job-1", mptTaskId: "mpt-task-77" });
    expect(markProcessing).toHaveBeenCalledWith("job-1", "mpt-task-77");
    expect(incrementVideosGenerated).toHaveBeenCalledWith(WS, 1);
    expect(markFailed).not.toHaveBeenCalled();
  });

  it("maps the decrypted BYO keys into the MPT renderParams", async () => {
    await startVideoRender(WS, {
      videoSubject: "Launch recap",
      videoAspect: "16:9",
      videoScript: "scene one",
      voiceName: "en-US-Guy",
    });
    expect(createRenderJob).toHaveBeenCalledTimes(1);
    const sent = createRenderJob.mock.calls[0][0];
    expect(sent).toMatchObject({
      video_subject: "Launch recap",
      video_aspect: "16:9",
      video_source: "pexels",
      video_script: "scene one",
      voice_name: "en-US-Guy",
      llm_provider: "deepseek",
      llm_api_key: "sk-deepseek-byo",
      llm_model_name: "deepseek-chat",
      llm_base_url: "https://api.deepseek.com",
      pexels_api_keys: ["pexels-byo-a", "pexels-byo-b"],
    });
  });

  it("threads the workspace brand style into the MPT video_subject (script untouched)", async () => {
    // A workspace WITH a brand identity: the MPT subject MPT uses to pick stock
    // footage + write the script should carry the brand fragment, but the
    // verbatim post-copy script must NOT be polluted.
    loadBrandStyleMock.mockResolvedValueOnce({
      colors: ["#1A2B3C"],
      visualTone: "polished and professional",
      voiceHint: null,
      hasLogo: false,
      subjectContext: null,
    });
    await startVideoRender(WS, { videoSubject: "Launch recap", videoScript: "scene one" });
    const sent = createRenderJob.mock.calls[0][0] as { video_subject: string; video_script?: string };
    expect(sent.video_subject).toContain("Launch recap");
    expect(sent.video_subject).toContain("On-brand styling");
    expect(sent.video_subject).toContain("#1A2B3C");
    // The narration script is verbatim and must stay byte-for-byte.
    expect(sent.video_script).toBe("scene one");
    // The persisted job params keep the ORIGINAL subject for an honest audit.
    const jobParams = createJob.mock.calls[0][0] as { params: { video_subject: string } };
    expect(jobParams.params.video_subject).toBe("Launch recap");
  });

  it("ALWAYS sends a voice_name — defaulting when the caller leaves it blank", async () => {
    // Regression: an empty/absent voice made MPT's TTS step fail with
    // `Invalid voice ''`, killing the render at the audio stage (state -1).
    // The orchestrator must substitute a valid default.
    await startVideoRender(WS, { videoSubject: "Launch recap" });
    const sent = createRenderJob.mock.calls[0][0] as { voice_name?: string };
    expect(sent.voice_name).toBe("en-US-JennyNeural-Female");

    createRenderJob.mockClear();
    // Whitespace-only is treated as blank → still defaulted.
    await startVideoRender(WS, { videoSubject: "Launch recap", voiceName: "   " });
    const sent2 = createRenderJob.mock.calls[0][0] as { voice_name?: string };
    expect(sent2.voice_name).toBe("en-US-JennyNeural-Female");
  });
});

describe("startVideoRender: ordering guarantees", () => {
  it("checks quota BEFORE calling MPT", async () => {
    await startVideoRender(WS, { videoSubject: "x" });
    const quotaOrder = assertWithinVideoQuota.mock.invocationCallOrder[0];
    const mptOrder = createRenderJob.mock.invocationCallOrder[0];
    expect(quotaOrder).toBeLessThan(mptOrder);
  });

  it("checks quota BEFORE decrypting the BYO keys", async () => {
    await startVideoRender(WS, { videoSubject: "x" });
    expect(assertWithinVideoQuota.mock.invocationCallOrder[0]).toBeLessThan(
      getWorkspaceKeys.mock.invocationCallOrder[0],
    );
  });

  it("does NOT meter the render until after MPT accepts (increment after markProcessing)", async () => {
    await startVideoRender(WS, { videoSubject: "x" });
    expect(markProcessing.mock.invocationCallOrder[0]).toBeLessThan(
      incrementVideosGenerated.mock.invocationCallOrder[0],
    );
  });
});

describe("startVideoRender: failure handling", () => {
  it("on an MPT throw, marks the job failed and rethrows VideoRenderError", async () => {
    createRenderJob.mockRejectedValueOnce(new Error("MPT createRenderJob failed (429)"));
    await expect(startVideoRender(WS, { videoSubject: "x" })).rejects.toBeInstanceOf(
      VideoRenderError,
    );
    expect(markFailed).toHaveBeenCalledWith("job-1", "MPT createRenderJob failed (429)");
    // A failed render must NOT burn quota.
    expect(incrementVideosGenerated).not.toHaveBeenCalled();
    expect(markProcessing).not.toHaveBeenCalled();
  });

  it("lets a QuotaExceededError propagate WITHOUT creating a job or calling MPT", async () => {
    const quotaErr = new Error("quota");
    quotaErr.name = "QuotaExceededError";
    assertWithinVideoQuota.mockRejectedValueOnce(quotaErr);
    await expect(startVideoRender(WS, { videoSubject: "x" })).rejects.toThrow("quota");
    expect(createJob).not.toHaveBeenCalled();
    expect(createRenderJob).not.toHaveBeenCalled();
  });

  it("throws VideoRenderError when MPT is not configured (no quota/job/MPT calls)", async () => {
    mptConfigured.mockReturnValue(false);
    await expect(startVideoRender(WS, { videoSubject: "x" })).rejects.toBeInstanceOf(
      VideoRenderError,
    );
    expect(assertWithinVideoQuota).not.toHaveBeenCalled();
    expect(createRenderJob).not.toHaveBeenCalled();
  });

  it("throws VideoRenderError when videoSubject is blank", async () => {
    await expect(startVideoRender(WS, { videoSubject: "   " })).rejects.toBeInstanceOf(
      VideoRenderError,
    );
    expect(assertWithinVideoQuota).not.toHaveBeenCalled();
  });

  it("throws VideoRenderError when the workspace has no LLM key", async () => {
    getWorkspaceKeys.mockResolvedValueOnce({ pexels: { api_keys: ["p"] } });
    await expect(startVideoRender(WS, { videoSubject: "x" })).rejects.toThrow(/No LLM API key/);
    expect(createRenderJob).not.toHaveBeenCalled();
  });

  it("throws VideoRenderError when the workspace has no Pexels key", async () => {
    getWorkspaceKeys.mockResolvedValueOnce({
      llm: { provider: "openai", api_key: "k", model_name: "m" },
      pexels: { api_keys: [] },
    });
    await expect(startVideoRender(WS, { videoSubject: "x" })).rejects.toThrow(/No Pexels API key/);
    expect(createRenderJob).not.toHaveBeenCalled();
  });
});
