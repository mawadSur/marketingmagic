import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Unit: video analysis (src/lib/video/analyze/*) ───────────────────────────
//
// The analyze module is the BYO-key + user-chosen-model video-hook breakdown
// (Hormozi slice 2). We mock @/lib/env so geminiApiBase() returns a fixed base
// without a real serverEnv() parse, and stub global fetch so NO live Gemini call
// is ever made. The tests cover:
//   - analyzeVideo() returns the structured {transcript, visual_breakdown,
//     hook_spoken, hook_visual} shape (Gemini path, mocked fetch).
//   - selectAnalyzer() picks the gemini backend by model family and rejects an
//     unsupported model.
//   - boundary validation (missing key / missing bytes+url) throws
//     VideoAnalysisError before any fetch.
//   - the JSON-parse defenses (markdown fence, malformed parts) behave.

vi.mock("@/lib/env", () => ({
  geminiApiBase: () => "https://gemini.test/v1beta",
}));

import { analyzeVideo, selectAnalyzer, VideoAnalysisError } from "@/lib/video/analyze";
import { geminiVideoAnalyzer, normalize } from "@/lib/video/analyze/gemini-analyzer";

// Build a Gemini generateContent response whose single text part is the given
// JSON string (what the model "returns").
function geminiResponse(jsonText: string) {
  return {
    candidates: [{ content: { parts: [{ text: jsonText }] } }],
  };
}

const GOOD_ANALYSIS = {
  transcript: "Here's the one trick nobody tells you about cold outreach.",
  hook_spoken: "Here's the one trick nobody tells you",
  hook_visual: "Close-up of the creator pointing at the camera",
  visual_breakdown: {
    firstFiveSeconds: "Creator center-frame, bold yellow caption appears.",
    patternInterrupts: [
      { atSeconds: 1.5, description: "Hard cut to a phone screen" },
      { atSeconds: 3.0, description: "Zoom punch-in on the face" },
    ],
    onScreenText: ["THE 1 TRICK", "Save this"],
  },
};

function okFetch(jsonText: string) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(geminiResponse(jsonText)),
    text: () => Promise.resolve(""),
  });
}

const BYTES = new Uint8Array([0, 1, 2, 3]);
const BASE_INPUT = { bytes: BYTES, apiKey: "AIza-secret", model: "gemini-2.5-flash" } as const;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("selectAnalyzer: dispatch by model family", () => {
  it("routes a gemini-* model to the gemini backend", () => {
    expect(selectAnalyzer("gemini-2.5-flash").name).toBe("gemini");
    expect(selectAnalyzer("gemini-1.5-pro").name).toBe("gemini");
    // Case-insensitive.
    expect(selectAnalyzer("Gemini-2.5").name).toBe("gemini");
  });

  it("throws VideoAnalysisError for a model no backend supports", () => {
    expect(() => selectAnalyzer("gpt-4o")).toThrow(VideoAnalysisError);
    expect(() => selectAnalyzer("claude-opus-4")).toThrow(VideoAnalysisError);
  });

  it("throws on an empty model", () => {
    expect(() => selectAnalyzer("")).toThrow(VideoAnalysisError);
  });
});

describe("analyzeVideo: structured shape (gemini path, mocked fetch)", () => {
  it("returns {transcript, visual_breakdown, hook_spoken, hook_visual} from the model JSON", async () => {
    const fetchMock = okFetch(JSON.stringify(GOOD_ANALYSIS));
    vi.stubGlobal("fetch", fetchMock);

    const result = await analyzeVideo({ ...BASE_INPUT });

    expect(result.transcript).toBe(GOOD_ANALYSIS.transcript);
    expect(result.hook_spoken).toBe(GOOD_ANALYSIS.hook_spoken);
    expect(result.hook_visual).toBe(GOOD_ANALYSIS.hook_visual);
    expect(result.visual_breakdown.firstFiveSeconds).toBe(
      GOOD_ANALYSIS.visual_breakdown.firstFiveSeconds,
    );
    expect(result.visual_breakdown.patternInterrupts).toHaveLength(2);
    expect(result.visual_breakdown.patternInterrupts[0]).toEqual({
      atSeconds: 1.5,
      description: "Hard cut to a phone screen",
    });
    expect(result.visual_breakdown.onScreenText).toEqual(["THE 1 TRICK", "Save this"]);
    // `raw` keeps the verbatim envelope for re-parsing.
    expect(result.raw).toBeTruthy();
  });

  it("hits the env-driven base + chosen model endpoint (no hardcoded URL)", async () => {
    const fetchMock = okFetch(JSON.stringify(GOOD_ANALYSIS));
    vi.stubGlobal("fetch", fetchMock);

    await analyzeVideo({ ...BASE_INPUT });

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("https://gemini.test/v1beta/models/gemini-2.5-flash:generateContent");
    // The BYO key rides in the query string (Gemini's contract).
    expect(url).toContain("key=AIza-secret");
  });

  it("sends the video bytes as inline_data base64 + the JSON-mode config", async () => {
    const fetchMock = okFetch(JSON.stringify(GOOD_ANALYSIS));
    vi.stubGlobal("fetch", fetchMock);

    await analyzeVideo({ ...BASE_INPUT, contentType: "video/mp4" });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    const parts = body.contents[0].parts;
    expect(parts[0].inline_data.mime_type).toBe("video/mp4");
    expect(parts[0].inline_data.data).toBe(Buffer.from(BYTES).toString("base64"));
    expect(body.generationConfig.responseMimeType).toBe("application/json");
  });

  it("tolerates a ```json fenced response from the model", async () => {
    const fenced = "```json\n" + JSON.stringify(GOOD_ANALYSIS) + "\n```";
    vi.stubGlobal("fetch", okFetch(fenced));
    const result = await analyzeVideo({ ...BASE_INPUT });
    expect(result.hook_spoken).toBe(GOOD_ANALYSIS.hook_spoken);
  });

  it("defends partial JSON (missing fields → empty strings/arrays, never throws)", async () => {
    vi.stubGlobal("fetch", okFetch(JSON.stringify({ transcript: "only this" })));
    const result = await analyzeVideo({ ...BASE_INPUT });
    expect(result.transcript).toBe("only this");
    expect(result.hook_spoken).toBe("");
    expect(result.visual_breakdown.firstFiveSeconds).toBe("");
    expect(result.visual_breakdown.patternInterrupts).toEqual([]);
    expect(result.visual_breakdown.onScreenText).toEqual([]);
  });
});

describe("analyzeVideo: boundary validation (no fetch on bad input)", () => {
  it("throws without an API key — before any network call", async () => {
    const fetchMock = okFetch(JSON.stringify(GOOD_ANALYSIS));
    vi.stubGlobal("fetch", fetchMock);
    await expect(analyzeVideo({ ...BASE_INPUT, apiKey: "" })).rejects.toBeInstanceOf(
      VideoAnalysisError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws without bytes or a videoUrl", async () => {
    const fetchMock = okFetch(JSON.stringify(GOOD_ANALYSIS));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      analyzeVideo({ apiKey: "AIza-secret", model: "gemini-2.5-flash" }),
    ).rejects.toBeInstanceOf(VideoAnalysisError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("gemini backend: error mapping", () => {
  it("maps a non-OK response to VideoAnalysisError with the status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: () => Promise.resolve("PERMISSION_DENIED"),
        json: () => Promise.resolve({}),
      }),
    );
    await expect(geminiVideoAnalyzer.analyze({ ...BASE_INPUT })).rejects.toThrow(/403/);
  });

  it("throws when the model returns non-JSON text", () => {
    expect(() => normalize("this is not json", {})).toThrow(VideoAnalysisError);
  });

  it("supportsModel only claims the gemini family", () => {
    expect(geminiVideoAnalyzer.supportsModel("gemini-2.5-flash")).toBe(true);
    expect(geminiVideoAnalyzer.supportsModel("gpt-4o")).toBe(false);
  });
});
