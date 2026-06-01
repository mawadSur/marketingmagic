import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Unit: fal.ai reference-video adapter (src/lib/video/reference/fal-video-provider.ts) ──
//
// We mock @/lib/env (referenceVideoFalModel) and global fetch so NO live fal
// call is ever made. The focus is the status mapping (IN_QUEUE/IN_PROGRESS →
// processing, COMPLETED → ready, moderation → failed) and the submit/fetchBytes
// shapes.

vi.mock("@/lib/env", () => ({
  referenceVideoFalModel: () => "fal-ai/test-model/image-to-video",
}));

import { FalReferenceVideoProvider } from "@/lib/video/reference/fal-video-provider";
import type { ReferenceVideoInputs } from "@/lib/video/reference/provider";

const provider = new FalReferenceVideoProvider();
const KEY = "test-fal-key";

const INPUT: ReferenceVideoInputs = {
  referenceImageUrl: "https://example.com/photo.jpg",
  prompt: "slow push-in",
  aspect: "9:16",
  durationSeconds: 5,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("submit", () => {
  it("POSTs to the queue endpoint with image_url/prompt/aspect_ratio and returns request_id", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ request_id: "req-123" }));

    const res = await provider.submit(INPUT, KEY);

    expect(res).toEqual({ providerJobId: "req-123", provider: "fal_video" });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://queue.fal.run/fal-ai/test-model/image-to-video");
    expect((opts as RequestInit).method).toBe("POST");
    const headers = (opts as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Key ${KEY}`);
    const sent = JSON.parse((opts as RequestInit).body as string);
    expect(sent.image_url).toBe(INPUT.referenceImageUrl);
    expect(sent.prompt).toBe("slow push-in");
    expect(sent.aspect_ratio).toBe("9:16");
    expect(sent.duration).toBe("5");
  });

  it("throws a clear content-policy error on a moderation rejection", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("Request blocked by content moderation policy", { status: 422 }),
    );
    await expect(provider.submit(INPUT, KEY)).rejects.toThrow(/content policy/i);
  });

  it("throws when no request_id comes back", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    await expect(provider.submit(INPUT, KEY)).rejects.toThrow(/no request_id/i);
  });
});

describe("poll status mapping", () => {
  it("maps IN_QUEUE → processing", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "IN_QUEUE" }));
    const res = await provider.poll("req-1", KEY);
    expect(res.status).toBe("processing");
  });

  it("maps IN_PROGRESS → processing", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "IN_PROGRESS" }));
    const res = await provider.poll("req-1", KEY);
    expect(res.status).toBe("processing");
  });

  it("maps COMPLETED → ready and fetches the result video URL", async () => {
    // First call: status. Second call: result envelope.
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ status: "COMPLETED" }))
      .mockResolvedValueOnce(jsonResponse({ video: { url: "https://cdn.fal/out.mp4" } }));
    const res = await provider.poll("req-1", KEY);
    expect(res.status).toBe("ready");
    expect(res.videoUrl).toBe("https://cdn.fal/out.mp4");
  });

  it("maps an error payload → failed (moderation reason surfaced)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "IN_PROGRESS", error: "NSFW content flagged" }));
    const res = await provider.poll("req-1", KEY);
    expect(res.status).toBe("failed");
    expect(res.failureReason).toMatch(/content policy/i);
  });

  it("maps a 422 status response → failed", async () => {
    fetchMock.mockResolvedValueOnce(new Response("unprocessable", { status: 422 }));
    const res = await provider.poll("req-1", KEY);
    expect(res.status).toBe("failed");
  });

  it("treats a transient 5xx as processing (retried next tick)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("upstream", { status: 503 }));
    const res = await provider.poll("req-1", KEY);
    expect(res.status).toBe("processing");
  });

  it("fails when COMPLETED but the result has no video URL", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ status: "COMPLETED" }))
      .mockResolvedValueOnce(jsonResponse({}));
    const res = await provider.poll("req-1", KEY);
    expect(res.status).toBe("failed");
  });
});

describe("fetchBytes", () => {
  it("pulls the mp4 bytes and content-type from the CDN URL", async () => {
    const buf = new Uint8Array([1, 2, 3, 4]);
    fetchMock.mockResolvedValueOnce(
      new Response(buf, { status: 200, headers: { "content-type": "video/mp4" } }),
    );
    const res = await provider.fetchBytes("https://cdn.fal/out.mp4", KEY);
    expect(res.contentType).toBe("video/mp4");
    expect(Array.from(res.bytes)).toEqual([1, 2, 3, 4]);
  });

  it("throws when the CDN fetch fails", async () => {
    fetchMock.mockResolvedValueOnce(new Response("gone", { status: 404 }));
    await expect(provider.fetchBytes("https://cdn.fal/out.mp4", KEY)).rejects.toThrow(/fetch failed/i);
  });
});
