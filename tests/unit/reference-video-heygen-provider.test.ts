import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Unit: HeyGen reference-video adapter (src/lib/video/reference/heygen-video-provider.ts) ──
//
// Capability B "Make it talk" — talking-avatar via the HeyGen API (the SECOND
// 'present' provider, alongside D-ID). We mock @/lib/env (heygenBaseUrl /
// heygenDefaultVoiceId) and global fetch so NO live HeyGen call is ever made.
// Focus: the status mapping (pending/processing/waiting → processing,
// completed → ready, failed → failed with the provider reason, moderation/consent
// rejection flagged), plus the submit/fetchBytes shapes + the X-Api-Key auth.

vi.mock("@/lib/env", () => ({
  heygenBaseUrl: () => "https://api.heygen.test",
  heygenDefaultVoiceId: () => "default-voice-id",
}));

import { HeyGenReferenceVideoProvider } from "@/lib/video/reference/heygen-video-provider";
import type { ReferenceVideoInputs } from "@/lib/video/reference/provider";

const provider = new HeyGenReferenceVideoProvider();
const KEY = "test-heygen-key";

const INPUT: ReferenceVideoInputs = {
  referenceImageUrl: "https://example.com/photo.jpg",
  prompt: "",
  aspect: "9:16",
  script: "Hello from the HeyGen avatar.",
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
  it("POSTs to /v2/video/generate with X-Api-Key, talking_photo + text voice, returns the video id", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { video_id: "vid-123" } }));

    const res = await provider.submit(INPUT, KEY);

    expect(res).toEqual({ providerJobId: "vid-123", provider: "heygen_video" });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.heygen.test/v2/video/generate");
    expect((opts as RequestInit).method).toBe("POST");
    const headers = (opts as RequestInit).headers as Record<string, string>;
    // HeyGen auth is the X-Api-Key header (not Bearer/Basic).
    expect(headers["X-Api-Key"]).toBe(KEY);
    const sent = JSON.parse((opts as RequestInit).body as string);
    const vi0 = sent.video_inputs[0];
    expect(vi0.character.type).toBe("talking_photo");
    expect(vi0.character.photo_url).toBe(INPUT.referenceImageUrl);
    expect(vi0.voice.type).toBe("text");
    expect(vi0.voice.input_text).toBe("Hello from the HeyGen avatar.");
    // Falls back to the deployment default voice when none supplied.
    expect(vi0.voice.voice_id).toBe("default-voice-id");
    // 9:16 maps to a portrait dimension.
    expect(sent.dimension).toEqual({ width: 720, height: 1280 });
  });

  it("uses the supplied voiceId when present", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { video_id: "vid-9" } }));
    await provider.submit({ ...INPUT, voiceId: "custom-heygen-voice" }, KEY);
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.video_inputs[0].voice.voice_id).toBe("custom-heygen-voice");
  });

  it("throws when the script is empty (defence in depth)", async () => {
    await expect(provider.submit({ ...INPUT, script: "   " }, KEY)).rejects.toThrow(/script/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws a clear content/consent-policy error on a moderation rejection", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("Request rejected: unauthorized use / consent policy", { status: 403 }),
    );
    await expect(provider.submit(INPUT, KEY)).rejects.toThrow(/content\/consent policy/i);
  });

  it("throws when no video id comes back", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: {} }));
    await expect(provider.submit(INPUT, KEY)).rejects.toThrow(/no video id/i);
  });

  it("surfaces a HeyGen error-envelope message (200 with non-zero code)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 40001, message: "invalid voice_id" }));
    await expect(provider.submit(INPUT, KEY)).rejects.toThrow(/invalid voice_id/i);
  });
});

describe("submit · voice requirement (no default)", () => {
  it("throws when neither a voiceId nor a deployment default is available", async () => {
    // Re-mock env so heygenDefaultVoiceId() returns empty, and re-import the
    // module fresh so it picks up the new mock.
    vi.resetModules();
    vi.doMock("@/lib/env", () => ({
      heygenBaseUrl: () => "https://api.heygen.test",
      heygenDefaultVoiceId: () => "",
    }));
    const { HeyGenReferenceVideoProvider: Fresh } = await import(
      "@/lib/video/reference/heygen-video-provider"
    );
    const p = new Fresh();
    await expect(p.submit(INPUT, KEY)).rejects.toThrow(/voice/i);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.doUnmock("@/lib/env");
    vi.resetModules();
  });
});

describe("poll status mapping", () => {
  it("maps pending → processing", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { status: "pending" } }));
    expect((await provider.poll("vid-1", KEY)).status).toBe("processing");
  });

  it("maps processing → processing", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { status: "processing" } }));
    expect((await provider.poll("vid-1", KEY)).status).toBe("processing");
  });

  it("maps waiting → processing", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { status: "waiting" } }));
    expect((await provider.poll("vid-1", KEY)).status).toBe("processing");
  });

  it("maps completed → ready with the video_url", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: { status: "completed", video_url: "https://cdn.heygen/out.mp4" } }),
    );
    const res = await provider.poll("vid-1", KEY);
    expect(res.status).toBe("ready");
    expect(res.videoUrl).toBe("https://cdn.heygen/out.mp4");
  });

  it("maps failed → failed and surfaces the provider reason", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: { status: "failed", error: { code: "RENDER", message: "face not detected" } } }),
    );
    const res = await provider.poll("vid-1", KEY);
    expect(res.status).toBe("failed");
    expect(res.failureReason).toMatch(/face not detected/i);
  });

  it("maps failed → failed and flags a moderation/consent reason", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: { status: "failed", error: "Moderation: not allowed" } }),
    );
    const res = await provider.poll("vid-1", KEY);
    expect(res.status).toBe("failed");
    expect(res.failureReason).toMatch(/content\/consent policy/i);
  });

  it("fails when completed but there's no video_url", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { status: "completed" } }));
    expect((await provider.poll("vid-1", KEY)).status).toBe("failed");
  });

  it("maps a terminal 4xx status response → failed", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not found", { status: 404 }));
    expect((await provider.poll("vid-1", KEY)).status).toBe("failed");
  });

  it("treats a transient 5xx as processing (retried next tick)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("upstream", { status: 503 }));
    expect((await provider.poll("vid-1", KEY)).status).toBe("processing");
  });

  it("keeps an unknown status as processing (not a hard fail)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { status: "queued_v2" } }));
    expect((await provider.poll("vid-1", KEY)).status).toBe("processing");
  });
});

describe("fetchBytes", () => {
  it("pulls the mp4 bytes and content-type from the CDN URL", async () => {
    const buf = new Uint8Array([4, 5, 6]);
    fetchMock.mockResolvedValueOnce(
      new Response(buf, { status: 200, headers: { "content-type": "video/mp4" } }),
    );
    const res = await provider.fetchBytes("https://cdn.heygen/out.mp4", KEY);
    expect(res.contentType).toBe("video/mp4");
    expect(Array.from(res.bytes)).toEqual([4, 5, 6]);
  });

  it("throws when the CDN fetch fails", async () => {
    fetchMock.mockResolvedValueOnce(new Response("gone", { status: 404 }));
    await expect(provider.fetchBytes("https://cdn.heygen/out.mp4", KEY)).rejects.toThrow(/fetch failed/i);
  });
});
