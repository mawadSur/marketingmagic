import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Unit: Higgsfield UGC avatar video adapter (mocked fetch) ─────────────────
// Verifies submit → poll → fetchBytes against a stubbed Higgsfield REST surface.
// No live call; env is mocked so base URL / model are deterministic.

vi.mock("@/lib/env", () => ({
  higgsfieldBaseUrl: () => "https://platform.higgsfield.ai",
  higgsfieldModel: () => "higgsfield-ugc-avatar",
}));

import { higgsfieldReferenceVideoProvider as hf } from "@/lib/video/reference/higgsfield-video-provider";

let calls: Array<{ url: string; init?: RequestInit }> = [];
let responders: Array<(url: string, init?: RequestInit) => Response> = [];
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  calls = [];
  responders = [];
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    const r = responders.shift();
    if (!r) throw new Error(`unexpected fetch: ${url}`);
    return Promise.resolve(r(url, init));
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const INPUT = {
  referenceImageUrl: "https://cdn/avatar.png",
  prompt: "Launch recap",
  script: "Here is what shipped this week.",
  aspect: "9:16" as const,
  durationSeconds: 15,
};

describe("Higgsfield submit", () => {
  it("POSTs the avatar + script with Bearer auth and returns the job id", async () => {
    responders.push(() => json({ id: "hf-123" }));
    const res = await hf.submit(INPUT, "hf-key");
    expect(res).toEqual({ providerJobId: "hf-123", provider: "higgsfield_video" });
    const call = calls[0]!;
    expect(call.url).toBe("https://platform.higgsfield.ai/v1/generations");
    expect((call.init!.headers as Record<string, string>).Authorization).toBe("Bearer hf-key");
    const body = JSON.parse(String(call.init!.body));
    expect(body).toMatchObject({
      model: "higgsfield-ugc-avatar",
      input_image_url: INPUT.referenceImageUrl,
      prompt: INPUT.script, // script preferred over motion prompt for UGC
      script: INPUT.script,
      aspect_ratio: "9:16",
      duration: 15,
    });
  });

  it("surfaces a content-policy rejection distinctly", async () => {
    responders.push(() => new Response("request blocked by moderation", { status: 400 }));
    await expect(hf.submit(INPUT, "hf-key")).rejects.toThrow(/content policy/i);
  });
});

describe("Higgsfield poll", () => {
  it("maps processing → ready and digs out the video URL", async () => {
    responders.push(() => json({ status: "processing", progress: 40 }));
    expect(await hf.poll("hf-123", "k")).toMatchObject({ status: "processing", progress: 40 });

    responders.push(() => json({ status: "completed", output: { video_url: "https://cdn/out.mp4" } }));
    expect(await hf.poll("hf-123", "k")).toEqual({
      status: "ready",
      progress: 100,
      videoUrl: "https://cdn/out.mp4",
    });
  });

  it("maps failed/error status to a terminal failure with reason", async () => {
    responders.push(() => json({ status: "failed", error: "render engine crashed" }));
    expect(await hf.poll("hf-123", "k")).toMatchObject({
      status: "failed",
      failureReason: "render engine crashed",
    });
  });

  it("treats a transient 5xx as still-processing (cron retries)", async () => {
    responders.push(() => new Response("upstream", { status: 503 }));
    expect(await hf.poll("hf-123", "k")).toEqual({ status: "processing" });
  });
});

describe("Higgsfield fetchBytes", () => {
  it("pulls the mp4 bytes + content type", async () => {
    responders.push(() => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "video/mp4" } }));
    const { bytes, contentType } = await hf.fetchBytes("https://cdn/out.mp4", "k");
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(contentType).toBe("video/mp4");
  });
});
