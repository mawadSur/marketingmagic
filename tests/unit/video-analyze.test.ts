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

import {
  analyzeVideo,
  selectAnalyzer,
  VideoAnalysisError,
  HOOK_CRITERIA,
} from "@/lib/video/analyze";
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
  hook_rating: {
    score: 82,
    verdict: "Strong scroll-stopper, weak CTA",
    criteria: [
      { key: "scroll_stop", label: "Scroll-stop power", score: 9, reason: "Punchy first frame" },
      { key: "clarity", label: "Clarity of promise", score: 8, reason: "Clear payoff" },
      { key: "curiosity", label: "Curiosity / tension", score: 9, reason: "Open loop" },
      { key: "specificity", label: "Specificity", score: 7, reason: "One concrete claim" },
      { key: "callout", label: "Audience call-out", score: 6, reason: "Implicit only" },
    ],
    improvements: ["Add a who-this-is-for callout in the first second", "End on a stronger CTA"],
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
    // The graded hook rating rides alongside the breakdown.
    expect(result.hook_rating.score).toBe(82);
    expect(result.hook_rating.verdict).toBe("Strong scroll-stopper, weak CTA");
    expect(result.hook_rating.criteria).toHaveLength(HOOK_CRITERIA.length);
    expect(result.hook_rating.criteria[0]).toEqual({
      key: "scroll_stop",
      label: "Scroll-stop power",
      score: 9,
      reason: "Punchy first frame",
    });
    expect(result.hook_rating.improvements).toHaveLength(2);
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
    // An absent rating degrades to a complete, zeroed object (full rubric, score 0).
    expect(result.hook_rating.score).toBe(0);
    expect(result.hook_rating.verdict).toBe("");
    expect(result.hook_rating.improvements).toEqual([]);
    expect(result.hook_rating.criteria).toHaveLength(HOOK_CRITERIA.length);
    expect(result.hook_rating.criteria.every((c) => c.score === 0)).toBe(true);
  });
});

describe("hook rating: parse + defend (normalize)", () => {
  it("clamps the overall score into 0–100 and rounds", () => {
    const high = normalize(JSON.stringify({ hook_rating: { score: 250 } }), {});
    expect(high.hook_rating.score).toBe(100);
    const low = normalize(JSON.stringify({ hook_rating: { score: -40 } }), {});
    expect(low.hook_rating.score).toBe(0);
    const rounded = normalize(JSON.stringify({ hook_rating: { score: 73.6 } }), {});
    expect(rounded.hook_rating.score).toBe(74);
  });

  it("coerces a string score and clamps per-criterion scores to 0–10", () => {
    const r = normalize(
      JSON.stringify({
        hook_rating: {
          score: "65",
          criteria: [{ key: "scroll_stop", score: 99, reason: "x" }],
        },
      }),
      {},
    );
    expect(r.hook_rating.score).toBe(65);
    const scrollStop = r.hook_rating.criteria.find((c) => c.key === "scroll_stop");
    expect(scrollStop?.score).toBe(10);
  });

  it("emits the full rubric in canonical order, backfilling missing dimensions to 0", () => {
    const r = normalize(
      JSON.stringify({
        hook_rating: {
          score: 50,
          // Only one dimension returned, out of order key only.
          criteria: [{ key: "curiosity", score: 8, reason: "open loop" }],
        },
      }),
      {},
    );
    expect(r.hook_rating.criteria.map((c) => c.key)).toEqual(HOOK_CRITERIA.map((c) => c.key));
    const curiosity = r.hook_rating.criteria.find((c) => c.key === "curiosity");
    expect(curiosity?.score).toBe(8);
    // A dimension the model omitted defaults to 0 with the rubric's label.
    const callout = r.hook_rating.criteria.find((c) => c.key === "callout");
    expect(callout?.score).toBe(0);
    expect(callout?.label).toBe("Audience call-out");
  });

  it("backfills the label from the rubric when the model omits it", () => {
    const r = normalize(
      JSON.stringify({ hook_rating: { score: 50, criteria: [{ key: "clarity", score: 7 }] } }),
      {},
    );
    const clarity = r.hook_rating.criteria.find((c) => c.key === "clarity");
    expect(clarity?.label).toBe("Clarity of promise");
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
