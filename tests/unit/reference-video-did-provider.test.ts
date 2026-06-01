import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Unit: D-ID reference-video adapter (src/lib/video/reference/did-video-provider.ts) ──
//
// Capability B "Make it talk" — talking-avatar via the D-ID Talks API. We mock
// @/lib/env (didBaseUrl / didDefaultVoiceId) and global fetch so NO live D-ID
// call is ever made. Focus: the status mapping
// (created/started → processing, done → ready, error/rejected → failed with the
// provider reason, moderation/consent rejection flagged), plus the submit/
// fetchBytes shapes.

vi.mock("@/lib/env", () => ({
  didBaseUrl: () => "https://api.d-id.test",
  didDefaultVoiceId: () => "en-US-DefaultVoice",
}));

import { DIdReferenceVideoProvider } from "@/lib/video/reference/did-video-provider";
import type { ReferenceVideoInputs } from "@/lib/video/reference/provider";

const provider = new DIdReferenceVideoProvider();
const KEY = "test-did-key";

const INPUT: ReferenceVideoInputs = {
  referenceImageUrl: "https://example.com/photo.jpg",
  prompt: "",
  aspect: "9:16",
  script: "Hello from the avatar.",
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
  it("POSTs to /talks with Basic auth, source_url + text script + voice, returns the talk id", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "talk-123" }));

    const res = await provider.submit(INPUT, KEY);

    expect(res).toEqual({ providerJobId: "talk-123", provider: "did_video" });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.d-id.test/talks");
    expect((opts as RequestInit).method).toBe("POST");
    const headers = (opts as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${KEY}`);
    const sent = JSON.parse((opts as RequestInit).body as string);
    expect(sent.source_url).toBe(INPUT.referenceImageUrl);
    expect(sent.script.type).toBe("text");
    expect(sent.script.input).toBe("Hello from the avatar.");
    expect(sent.script.provider.type).toBe("microsoft");
    // Falls back to the deployment default voice when none supplied.
    expect(sent.script.provider.voice_id).toBe("en-US-DefaultVoice");
  });

  it("uses the supplied voiceId when present", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "talk-9" }));
    await provider.submit({ ...INPUT, voiceId: "en-GB-RyanNeural" }, KEY);
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.script.provider.voice_id).toBe("en-GB-RyanNeural");
  });

  it("throws when the script is empty (defence in depth)", async () => {
    await expect(provider.submit({ ...INPUT, script: "   " }, KEY)).rejects.toThrow(/script/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws a clear content/consent-policy error on a moderation rejection", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("Request rejected: celebrity / consent policy", { status: 403 }),
    );
    await expect(provider.submit(INPUT, KEY)).rejects.toThrow(/content\/consent policy/i);
  });

  it("throws when no talk id comes back", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    await expect(provider.submit(INPUT, KEY)).rejects.toThrow(/no talk id/i);
  });
});

describe("poll status mapping", () => {
  it("maps created → processing", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "created" }));
    const res = await provider.poll("talk-1", KEY);
    expect(res.status).toBe("processing");
  });

  it("maps started → processing", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "started" }));
    const res = await provider.poll("talk-1", KEY);
    expect(res.status).toBe("processing");
  });

  it("maps done → ready with the result_url", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: "done", result_url: "https://cdn.d-id/out.mp4" }),
    );
    const res = await provider.poll("talk-1", KEY);
    expect(res.status).toBe("ready");
    expect(res.videoUrl).toBe("https://cdn.d-id/out.mp4");
  });

  it("maps error → failed and surfaces the provider reason", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: "error", error: { kind: "RenderError", description: "source face not found" } }),
    );
    const res = await provider.poll("talk-1", KEY);
    expect(res.status).toBe("failed");
    expect(res.failureReason).toMatch(/source face not found/i);
  });

  it("maps rejected → failed and flags a moderation/consent reason", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: "rejected", description: "Moderation: not allowed" }),
    );
    const res = await provider.poll("talk-1", KEY);
    expect(res.status).toBe("failed");
    expect(res.failureReason).toMatch(/content\/consent policy/i);
  });

  it("fails when done but there's no result_url", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "done" }));
    const res = await provider.poll("talk-1", KEY);
    expect(res.status).toBe("failed");
  });

  it("maps a terminal 4xx status response → failed", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not found", { status: 404 }));
    const res = await provider.poll("talk-1", KEY);
    expect(res.status).toBe("failed");
  });

  it("treats a transient 5xx as processing (retried next tick)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("upstream", { status: 503 }));
    const res = await provider.poll("talk-1", KEY);
    expect(res.status).toBe("processing");
  });
});

describe("fetchBytes", () => {
  it("pulls the mp4 bytes and content-type from the CDN URL", async () => {
    const buf = new Uint8Array([9, 8, 7]);
    fetchMock.mockResolvedValueOnce(
      new Response(buf, { status: 200, headers: { "content-type": "video/mp4" } }),
    );
    const res = await provider.fetchBytes("https://cdn.d-id/out.mp4", KEY);
    expect(res.contentType).toBe("video/mp4");
    expect(Array.from(res.bytes)).toEqual([9, 8, 7]);
  });

  it("throws when the CDN fetch fails", async () => {
    fetchMock.mockResolvedValueOnce(new Response("gone", { status: 404 }));
    await expect(provider.fetchBytes("https://cdn.d-id/out.mp4", KEY)).rejects.toThrow(/fetch failed/i);
  });
});
