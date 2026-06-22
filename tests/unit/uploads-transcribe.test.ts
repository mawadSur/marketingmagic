import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Unit: transcribeUploadedVideo (src/lib/video/uploads/transcribe-video.ts) ──
//
// Mocks the Groq HTTP call (global fetch) + the service-role Supabase client so
// no network / DB happens. Covers:
//   1. happy path — small video → direct Groq verbose_json → segments mapped to
//      ms, srt/vtt rendered, transcript upserted with provider=groq.
//   2. graceful degrade — GROQ_API_KEY unset → empty transcript upserted, no
//      throw, outcome status "empty".
//   3. large source with no audio-extraction wired → empty transcript, no throw.
//   4. missing source row → throws.
//   5. mapGroqSegments — second→ms mapping + junk filtering.

// ── env mock ──────────────────────────────────────────────────────────────
const groqKey = vi.fn<() => string | undefined>(() => "groq-test-key");
vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ GROQ_API_KEY: groqKey() }),
  // No MPT in this suite — the "too large" case degrades to an empty transcript
  // via the audio-extraction-unavailable path (mirrors a deployment with MPT off).
  mptConfigured: () => false,
}));

// ── service-role supabase mock ──────────────────────────────────────────────
// A tiny query-builder fake: `from(table)` returns chainable select/eq/maybeSingle
// and a recording `upsert`. Storage `download` returns a Blob.
const upsertCalls: Array<{ table: string; row: Record<string, unknown> }> = [];
let uploadedVideoRow: Record<string, unknown> | null = null;
let downloadBlob: Blob | null = null;

function makeFrom(table: string) {
  const builder: Record<string, unknown> = {};
  builder.select = () => builder;
  builder.eq = () => builder;
  builder.maybeSingle = async () => {
    if (table === "uploaded_videos") return { data: uploadedVideoRow, error: null };
    return { data: null, error: null };
  };
  builder.upsert = async (row: Record<string, unknown>) => {
    upsertCalls.push({ table, row });
    return { error: null };
  };
  return builder;
}

const storageDownload = vi.fn(async () => ({ data: downloadBlob, error: null }));

vi.mock("@/lib/supabase/service", () => ({
  supabaseService: () => ({
    from: (table: string) => makeFrom(table),
    storage: { from: () => ({ download: storageDownload }) },
  }),
}));

import {
  transcribeUploadedVideo,
  mapGroqSegments,
} from "@/lib/video/uploads/transcribe-video";

const FETCH = vi.fn();

beforeEach(() => {
  upsertCalls.length = 0;
  uploadedVideoRow = null;
  downloadBlob = new Blob([new Uint8Array([1, 2, 3])], { type: "video/mp4" });
  groqKey.mockReturnValue("groq-test-key");
  storageDownload.mockClear();
  vi.stubGlobal("fetch", FETCH);
  FETCH.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function groqOk(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("mapGroqSegments", () => {
  it("maps seconds → ms and drops malformed/empty/inverted entries", () => {
    const out = mapGroqSegments({
      segments: [
        { start: 0, end: 1.5, text: " Hello " },
        { start: 1.5, end: 3.2, text: "world" },
        { start: 4, end: 4, text: "zero-length" }, // dropped (end<=start)
        { start: 5, end: 6, text: "   " }, // dropped (empty text)
        { start: NaN, end: 7, text: "bad" }, // dropped (non-finite)
        { end: 8, text: "no-start" }, // dropped (missing start)
      ],
    });
    expect(out).toEqual([
      { startMs: 0, endMs: 1500, text: "Hello" },
      { startMs: 1500, endMs: 3200, text: "world" },
    ]);
  });

  it("returns [] when there are no segments", () => {
    expect(mapGroqSegments({})).toEqual([]);
  });
});

describe("transcribeUploadedVideo — happy path", () => {
  it("transcribes a small video and upserts segments + srt/vtt", async () => {
    uploadedVideoRow = {
      id: "uv-1",
      workspace_id: "ws-1",
      storage_path: "ws-1/uv-1/source.mp4",
      content_type: "video/mp4",
      size_bytes: 10 * 1024 * 1024,
    };
    FETCH.mockResolvedValueOnce(
      groqOk({
        text: "Hello world",
        language: "en",
        segments: [
          { start: 0, end: 1.5, text: "Hello" },
          { start: 1.5, end: 3, text: "world" },
        ],
      }),
    );

    const outcome = await transcribeUploadedVideo("uv-1");

    expect(outcome).toEqual({ status: "transcribed", segmentCount: 2, via: "video" });
    // Used the video directly — no audio extraction download path involved.
    expect(storageDownload).toHaveBeenCalledTimes(1);
    expect(FETCH).toHaveBeenCalledTimes(1);
    expect(FETCH.mock.calls[0][0]).toContain("api.groq.com");

    expect(upsertCalls).toHaveLength(1);
    const row = upsertCalls[0].row;
    expect(upsertCalls[0].table).toBe("video_transcripts");
    expect(row.provider).toBe("groq");
    expect(row.language).toBe("en");
    expect(row.edited).toBe(false);
    expect(row.text).toBe("Hello world");
    expect(row.segments).toEqual([
      { start_ms: 0, end_ms: 1500, text: "Hello" },
      { start_ms: 1500, end_ms: 3000, text: "world" },
    ]);
    expect(String(row.srt)).toContain("00:00:00,000 --> 00:00:01,500");
    expect(String(row.vtt)).toContain("WEBVTT");
  });
});

describe("transcribeUploadedVideo — graceful degrade", () => {
  it("upserts an empty transcript and does not throw when GROQ_API_KEY is unset", async () => {
    groqKey.mockReturnValue(undefined);
    uploadedVideoRow = {
      id: "uv-2",
      workspace_id: "ws-1",
      storage_path: "ws-1/uv-2/source.mp4",
      content_type: "video/mp4",
      size_bytes: 5_000_000,
    };

    const outcome = await transcribeUploadedVideo("uv-2");

    expect(outcome).toEqual({ status: "empty", reason: "transcription-not-configured" });
    expect(FETCH).not.toHaveBeenCalled();
    expect(storageDownload).not.toHaveBeenCalled();
    expect(upsertCalls).toHaveLength(1);
    const row = upsertCalls[0].row;
    expect(row.provider).toBeNull();
    expect(row.segments).toEqual([]);
    expect(row.text).toBeNull();
  });

  it("degrades to empty when the source is too large to transcribe directly", async () => {
    uploadedVideoRow = {
      id: "uv-3",
      workspace_id: "ws-1",
      storage_path: "ws-1/uv-3/source.mp4",
      content_type: "video/mp4",
      size_bytes: 500 * 1024 * 1024, // > 24MB direct cap, no MPT audio wired
    };

    const outcome = await transcribeUploadedVideo("uv-3");

    expect(outcome).toEqual({ status: "empty", reason: "audio-extraction-unavailable" });
    expect(FETCH).not.toHaveBeenCalled();
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].row.segments).toEqual([]);
  });
});

describe("transcribeUploadedVideo — missing source", () => {
  it("throws when the uploaded_video row does not exist", async () => {
    uploadedVideoRow = null;
    await expect(transcribeUploadedVideo("nope")).rejects.toThrow(/not found/);
  });
});
