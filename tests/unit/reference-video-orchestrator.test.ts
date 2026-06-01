import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Unit: startReferenceVideoRender consent guard + happy path ───────────────
//
// Mocks every dependency so NO DB / fal call happens. Focus:
//   1. consent !== true throws BEFORE any provider/createJob call.
//   2. flag-off throws.
//   3. missing fal key throws.
//   4. happy path stores consent_attested_at + consent_by in params, submits to
//      the provider, and marks the job processing with the request id.

const referenceVideoEnabled = vi.fn<() => boolean>();
vi.mock("@/lib/env", () => ({
  referenceVideoEnabled: () => referenceVideoEnabled(),
  mptConfigured: () => true,
}));

const assertWithinVideoQuota = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/billing/limits", () => ({
  assertWithinVideoQuota: (...a: unknown[]) => assertWithinVideoQuota(...a),
}));

const incrementVideosGenerated = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/billing/usage", () => ({
  incrementVideosGenerated: (...a: unknown[]) => incrementVideosGenerated(...a),
}));

const getWorkspaceKeys = vi.fn();
vi.mock("@/lib/video/byo-keys", () => ({
  getWorkspaceKeys: (...a: unknown[]) => getWorkspaceKeys(...a),
}));

const createJob = vi.fn();
const markProcessing = vi.fn().mockResolvedValue(undefined);
const markFailed = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/video/jobs", () => ({
  createJob: (...a: unknown[]) => createJob(...a),
  markProcessing: (...a: unknown[]) => markProcessing(...a),
  markFailed: (...a: unknown[]) => markFailed(...a),
}));

// MPT client is imported by the orchestrator module; stub so import resolves.
vi.mock("@/lib/video/mpt-client", () => ({
  createRenderJob: vi.fn(),
}));

const submit = vi.fn();
vi.mock("@/lib/video/reference/stub-provider", () => ({
  getReferenceVideoProvider: () => ({ name: "fal_video", submit, poll: vi.fn(), fetchBytes: vi.fn() }),
}));

import { startReferenceVideoRender } from "@/lib/video/orchestrator";

const WS = "ws-1";
const BASE_INPUT = {
  referenceImageUrl: "https://example.com/p.jpg",
  referenceImagePath: "ws-1/u1/reference.jpg",
  prompt: "gentle motion",
  consent: true,
  consentBy: "user-1",
};

beforeEach(() => {
  referenceVideoEnabled.mockReturnValue(true);
  getWorkspaceKeys.mockResolvedValue({ fal_video: { api_key: "fal-k" } });
  createJob.mockResolvedValue({ id: "job-1" });
  submit.mockResolvedValue({ providerJobId: "req-9", provider: "fal_video" });
});
afterEach(() => vi.clearAllMocks());

describe("consent guard", () => {
  it("throws when consent is not true and never touches the provider or DB", async () => {
    await expect(
      startReferenceVideoRender(WS, { ...BASE_INPUT, consent: false }),
    ).rejects.toThrow(/consent is required/i);
    expect(createJob).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(assertWithinVideoQuota).not.toHaveBeenCalled();
  });
});

describe("flag + key guards", () => {
  it("throws when the feature flag is off", async () => {
    referenceVideoEnabled.mockReturnValue(false);
    await expect(startReferenceVideoRender(WS, BASE_INPUT)).rejects.toThrow(/not enabled/i);
    expect(createJob).not.toHaveBeenCalled();
  });

  it("throws when no fal_video key is configured", async () => {
    getWorkspaceKeys.mockResolvedValue({});
    await expect(startReferenceVideoRender(WS, BASE_INPUT)).rejects.toThrow(/no fal video api key/i);
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("happy path", () => {
  it("stores the consent attestation in params and marks processing with the request id", async () => {
    const res = await startReferenceVideoRender(WS, BASE_INPUT);

    expect(res).toEqual({ jobId: "job-1", providerJobId: "req-9" });

    const params = createJob.mock.calls[0][0].params;
    expect(params.kind).toBe("reference_image");
    expect(params.provider).toBe("fal_video");
    expect(params.consent_by).toBe("user-1");
    expect(typeof params.consent_attested_at).toBe("string");
    expect(params.reference_path).toBe(BASE_INPUT.referenceImagePath);

    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ referenceImageUrl: BASE_INPUT.referenceImageUrl, prompt: "gentle motion" }),
      "fal-k",
    );
    expect(markProcessing).toHaveBeenCalledWith("job-1", "req-9");
    expect(incrementVideosGenerated).toHaveBeenCalledWith(WS, 1);
  });

  it("marks the job failed and rethrows when submit fails", async () => {
    submit.mockRejectedValueOnce(new Error("fal exploded"));
    await expect(startReferenceVideoRender(WS, BASE_INPUT)).rejects.toThrow(/fal exploded/i);
    expect(markFailed).toHaveBeenCalledWith("job-1", "fal exploded");
    expect(incrementVideosGenerated).not.toHaveBeenCalled();
  });
});
