import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Unit: MPT HTTP client (src/lib/video/mpt-client.ts) ──────────────────────
//
// We stub global `fetch` and `@/lib/env` serverEnv() so no real request leaves
// the process. The assertions pin the P1 HTTP contract: method, path, the
// `x-api-key` auth header, and that the BYO keys + params ride in the JSON body.

const MPT_BASE_URL = "https://mpt.example.com";
const MPT_API_TOKEN = "mpt-token-abcdef12";

// Mutable env so a single test can blank the config to trigger the
// not-configured path.
const envHolder = {
  MPT_BASE_URL: MPT_BASE_URL as string | undefined,
  MPT_API_TOKEN: MPT_API_TOKEN as string | undefined,
};

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({
    MPT_BASE_URL: envHolder.MPT_BASE_URL,
    MPT_API_TOKEN: envHolder.MPT_API_TOKEN,
  }),
}));

import {
  createRenderJob,
  createClipTask,
  extractAudioTask,
  deleteTask,
  downloadVideo,
  getTask,
  MptError,
  MptNotConfiguredError,
  fileNameFromVideoPath,
  type CreateRenderParams,
  type CreateClipParams,
} from "@/lib/video/mpt-client";

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const RENDER_PARAMS: CreateRenderParams = {
  video_subject: "Why TypeScript wins",
  video_aspect: "9:16",
  video_source: "pexels",
  subtitle_enabled: true,
  llm_provider: "openai",
  llm_api_key: "sk-byo-llm-key",
  llm_model_name: "gpt-4o-mini",
  pexels_api_keys: ["pexels-byo-1", "pexels-byo-2"],
};

beforeEach(() => {
  envHolder.MPT_BASE_URL = MPT_BASE_URL;
  envHolder.MPT_API_TOKEN = MPT_API_TOKEN;
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mpt-client: createRenderJob", () => {
  it("POSTs to {base}/api/v1/videos with x-api-key and a JSON body carrying BYO keys", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { task_id: "task-123" } }));

    const res = await createRenderJob(RENDER_PARAMS);
    expect(res.data.task_id).toBe("task-123");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${MPT_BASE_URL}/api/v1/videos`);
    expect(init.method).toBe("POST");

    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(MPT_API_TOKEN);
    expect(headers["content-type"]).toBe("application/json");

    // The decrypted BYO keys + params must be in the JSON body verbatim.
    const sent = JSON.parse(init.body as string);
    expect(sent).toMatchObject({
      video_subject: RENDER_PARAMS.video_subject,
      video_aspect: "9:16",
      video_source: "pexels",
      llm_provider: "openai",
      llm_api_key: "sk-byo-llm-key",
      llm_model_name: "gpt-4o-mini",
      pexels_api_keys: ["pexels-byo-1", "pexels-byo-2"],
    });
  });

  it("trims a trailing slash off MPT_BASE_URL before building the path", async () => {
    envHolder.MPT_BASE_URL = `${MPT_BASE_URL}/`;
    fetchMock.mockResolvedValue(jsonResponse({ data: { task_id: "t" } }));
    await createRenderJob(RENDER_PARAMS);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(`${MPT_BASE_URL}/api/v1/videos`);
  });

  it("throws MptError on a non-2xx response, carrying the status", async () => {
    fetchMock.mockResolvedValue(new Response("queue full", { status: 429 }));
    await expect(createRenderJob(RENDER_PARAMS)).rejects.toMatchObject({
      name: "MptError",
      status: 429,
    });
  });

  it("throws MptError when a 200 carries no task_id", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: {} }));
    await expect(createRenderJob(RENDER_PARAMS)).rejects.toBeInstanceOf(MptError);
  });

  it("throws MptNotConfiguredError when MPT env is unset (no fetch)", async () => {
    envHolder.MPT_BASE_URL = undefined;
    await expect(createRenderJob(RENDER_PARAMS)).rejects.toBeInstanceOf(MptNotConfiguredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("mpt-client: getTask", () => {
  it("GETs {base}/api/v1/tasks/{id} with the auth header", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { state: 4, progress: 42 } }));
    const res = await getTask("task abc/123");
    expect(res.data.state).toBe(4);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // Task id must be URI-encoded into the path.
    expect(url).toBe(`${MPT_BASE_URL}/api/v1/tasks/${encodeURIComponent("task abc/123")}`);
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe(MPT_API_TOKEN);
    expect(init.method ?? "GET").toBe("GET");
  });

  it("throws MptError on non-2xx", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 404 }));
    await expect(getTask("t")).rejects.toMatchObject({ name: "MptError", status: 404 });
  });
});

describe("mpt-client: downloadVideo", () => {
  it("GETs the download path with both segments URI-encoded and returns the raw Response", async () => {
    const body = jsonResponse({ ok: true });
    fetchMock.mockResolvedValue(body);
    const res = await downloadVideo("task-1", "final-1.mp4");
    expect(res).toBe(body);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(`${MPT_BASE_URL}/api/v1/download/task-1/final-1.mp4`);
  });

  it("throws MptError when download is non-2xx", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 500 }));
    await expect(downloadVideo("t", "f.mp4")).rejects.toMatchObject({ status: 500 });
  });
});

describe("mpt-client: deleteTask", () => {
  it("DELETEs {base}/api/v1/tasks/{id}", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 200 }));
    await deleteTask("task-9");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${MPT_BASE_URL}/api/v1/tasks/task-9`);
    expect(init.method).toBe("DELETE");
  });

  it("treats a 404 as success (cleanup is best-effort)", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 404 }));
    await expect(deleteTask("gone")).resolves.toBeUndefined();
  });

  it("throws MptError on a non-404 failure", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 500 }));
    await expect(deleteTask("t")).rejects.toMatchObject({ status: 500 });
  });
});

describe("mpt-client: fileNameFromVideoPath", () => {
  it("extracts the file segment from a {task}/file path", () => {
    expect(fileNameFromVideoPath("task-1/final-1.mp4")).toBe("final-1.mp4");
    expect(fileNameFromVideoPath("final.mp4")).toBe("final.mp4");
  });
});

const CLIP_PARAMS: CreateClipParams = {
  source_url: "https://supa.example.com/source.mp4?sig=abc",
  aspect: "9:16",
  clips: [
    { label: "hook", start_ms: 0, end_ms: 5000, burn_captions: true, subtitles_srt: "1\n..." },
    { label: "cta", start_ms: 12000, end_ms: 20000, burn_captions: false },
  ],
};

describe("mpt-client: createClipTask", () => {
  it("POSTs to {base}/api/v1/clip with x-api-key and the clip batch in the body", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { task_id: "clip-task-1" } }));

    const res = await createClipTask(CLIP_PARAMS);
    expect(res.data.task_id).toBe("clip-task-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${MPT_BASE_URL}/api/v1/clip`);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(MPT_API_TOKEN);
    expect(headers["content-type"]).toBe("application/json");

    const sent = JSON.parse(init.body as string);
    expect(sent).toMatchObject({
      source_url: CLIP_PARAMS.source_url,
      aspect: "9:16",
      clips: [
        { label: "hook", start_ms: 0, end_ms: 5000, burn_captions: true, subtitles_srt: "1\n..." },
        { label: "cta", start_ms: 12000, end_ms: 20000, burn_captions: false },
      ],
    });
  });

  it("throws MptError on non-2xx", async () => {
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));
    await expect(createClipTask(CLIP_PARAMS)).rejects.toMatchObject({
      name: "MptError",
      status: 500,
    });
  });

  it("throws MptError when a 200 carries no task_id", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: {} }));
    await expect(createClipTask(CLIP_PARAMS)).rejects.toBeInstanceOf(MptError);
  });

  it("throws MptNotConfiguredError when MPT env is unset (no fetch)", async () => {
    envHolder.MPT_API_TOKEN = undefined;
    await expect(createClipTask(CLIP_PARAMS)).rejects.toBeInstanceOf(MptNotConfiguredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("mpt-client: extractAudioTask", () => {
  it("POSTs to {base}/api/v1/extract-audio with the source_url in the body", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { task_id: "audio-task-7" } }));

    const res = await extractAudioTask({ sourceUrl: "https://supa.example.com/s.mp4?sig=z" });
    expect(res.data.task_id).toBe("audio-task-7");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${MPT_BASE_URL}/api/v1/extract-audio`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe(MPT_API_TOKEN);
    const sent = JSON.parse(init.body as string);
    expect(sent).toEqual({ source_url: "https://supa.example.com/s.mp4?sig=z" });
  });

  it("throws MptError on non-2xx", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 422 }));
    await expect(extractAudioTask({ sourceUrl: "u" })).rejects.toMatchObject({ status: 422 });
  });

  it("throws MptError when a 200 carries no task_id", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: {} }));
    await expect(extractAudioTask({ sourceUrl: "u" })).rejects.toBeInstanceOf(MptError);
  });
});
