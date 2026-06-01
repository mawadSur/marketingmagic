import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Unit: startReferenceVideoRender · Capability B "present" (D-ID) ───────────
//
// Mocks every dependency so NO DB / D-ID call happens. Focus on the new path:
//   1. capability "present" with no/empty script throws BEFORE any provider/DB.
//   2. consent !== true throws (stricter "appear to say these words" copy).
//   3. missing did_video key throws (and does NOT fall back to fal).
//   4. happy path stores capability/provider/script + consent in params, picks
//      the D-ID adapter, and submits with the did_video key.
//   5. "animate" is NOT regressed — it still requires a prompt + the fal key.

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

vi.mock("@/lib/video/mpt-client", () => ({ createRenderJob: vi.fn() }));

// The factory returns a fresh adapter keyed on capability so we can assert which
// one was picked and what key it received.
const didSubmit = vi.fn();
const falSubmit = vi.fn();
const getReferenceVideoProvider = vi.fn();
vi.mock("@/lib/video/reference/stub-provider", () => ({
  getReferenceVideoProvider: (...a: unknown[]) => getReferenceVideoProvider(...a),
}));

import { startReferenceVideoRender } from "@/lib/video/orchestrator";

const WS = "ws-1";
const PRESENT_INPUT = {
  capability: "present" as const,
  referenceImageUrl: "https://example.com/p.jpg",
  referenceImagePath: "ws-1/u1/reference.jpg",
  script: "Hello, this is me speaking.",
  voiceId: "en-US-JennyNeural",
  consent: true,
  consentBy: "user-1",
};

beforeEach(() => {
  referenceVideoEnabled.mockReturnValue(true);
  getWorkspaceKeys.mockResolvedValue({
    did_video: { api_key: "did-k" },
    fal_video: { api_key: "fal-k" },
  });
  createJob.mockResolvedValue({ id: "job-1" });
  didSubmit.mockResolvedValue({ providerJobId: "talk-9", provider: "did_video" });
  falSubmit.mockResolvedValue({ providerJobId: "req-9", provider: "fal_video" });
  getReferenceVideoProvider.mockImplementation((cap?: string) =>
    cap === "present"
      ? { name: "did_video", submit: didSubmit, poll: vi.fn(), fetchBytes: vi.fn() }
      : { name: "fal_video", submit: falSubmit, poll: vi.fn(), fetchBytes: vi.fn() },
  );
});
afterEach(() => vi.clearAllMocks());

describe("present · script guard", () => {
  it("throws when the script is empty and never touches the provider or DB", async () => {
    await expect(
      startReferenceVideoRender(WS, { ...PRESENT_INPUT, script: "   " }),
    ).rejects.toThrow(/script is required/i);
    expect(createJob).not.toHaveBeenCalled();
    expect(didSubmit).not.toHaveBeenCalled();
    expect(assertWithinVideoQuota).not.toHaveBeenCalled();
  });

  it("throws when the script is missing entirely", async () => {
    const { script: _omit, ...noScript } = PRESENT_INPUT;
    await expect(startReferenceVideoRender(WS, noScript)).rejects.toThrow(/script is required/i);
    expect(createJob).not.toHaveBeenCalled();
  });
});

describe("present · consent guard (stricter copy)", () => {
  it("throws with the 'appear to say these words' wording when consent is not true", async () => {
    await expect(
      startReferenceVideoRender(WS, { ...PRESENT_INPUT, consent: false }),
    ).rejects.toThrow(/appear to say these words/i);
    expect(createJob).not.toHaveBeenCalled();
    expect(didSubmit).not.toHaveBeenCalled();
  });
});

describe("present · key guard", () => {
  it("throws when no did_video key is configured (and does NOT use fal)", async () => {
    getWorkspaceKeys.mockResolvedValue({ fal_video: { api_key: "fal-k" } });
    await expect(startReferenceVideoRender(WS, PRESENT_INPUT)).rejects.toThrow(/no d-id api key/i);
    expect(didSubmit).not.toHaveBeenCalled();
    expect(falSubmit).not.toHaveBeenCalled();
  });
});

describe("present · happy path", () => {
  it("stores capability/provider/script + consent in params and submits to the D-ID adapter", async () => {
    const res = await startReferenceVideoRender(WS, PRESENT_INPUT);

    expect(res).toEqual({ jobId: "job-1", providerJobId: "talk-9" });

    const params = createJob.mock.calls[0][0].params;
    expect(params.kind).toBe("reference_image");
    expect(params.capability).toBe("present");
    expect(params.provider).toBe("did_video");
    expect(params.script).toBe(PRESENT_INPUT.script);
    expect(params.voice_id).toBe("en-US-JennyNeural");
    expect(params.consent_by).toBe("user-1");
    expect(typeof params.consent_attested_at).toBe("string");

    // The D-ID adapter was selected and given the did_video key + the script.
    expect(getReferenceVideoProvider).toHaveBeenCalledWith("present");
    expect(didSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ script: PRESENT_INPUT.script, voiceId: "en-US-JennyNeural" }),
      "did-k",
    );
    expect(falSubmit).not.toHaveBeenCalled();
    expect(markProcessing).toHaveBeenCalledWith("job-1", "talk-9");
    expect(incrementVideosGenerated).toHaveBeenCalledWith(WS, 1);
  });
});

describe("animate · NOT regressed", () => {
  it('still requires a prompt and uses the fal adapter + fal key for "animate"', async () => {
    const res = await startReferenceVideoRender(WS, {
      capability: "animate",
      referenceImageUrl: "https://example.com/p.jpg",
      referenceImagePath: "ws-1/u1/reference.jpg",
      prompt: "gentle push-in",
      consent: true,
      consentBy: "user-1",
    });

    expect(res).toEqual({ jobId: "job-1", providerJobId: "req-9" });
    const params = createJob.mock.calls[0][0].params;
    expect(params.capability).toBe("animate");
    expect(params.provider).toBe("fal_video");
    expect(getReferenceVideoProvider).toHaveBeenCalledWith("animate");
    expect(falSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "gentle push-in" }),
      "fal-k",
    );
    expect(didSubmit).not.toHaveBeenCalled();
  });

  it('throws when "animate" has no prompt', async () => {
    await expect(
      startReferenceVideoRender(WS, {
        capability: "animate",
        referenceImageUrl: "https://example.com/p.jpg",
        referenceImagePath: "ws-1/u1/reference.jpg",
        prompt: "  ",
        consent: true,
      }),
    ).rejects.toThrow(/prompt is required/i);
    expect(createJob).not.toHaveBeenCalled();
  });
});
