// Video analysis — Gemini native-video backend (Hormozi slice 2, recommended
// default).
//
// Implements VideoAnalyzer against the Gemini Generative Language API's
// generateContent endpoint. Gemini ingests video NATIVELY (audio + frames +
// temporal), so a single pass yields transcription + visual annotation +
// caption OCR — the temporal first-5s signal Claude's frames-only path loses.
//
// BYO-KEY: the workspace supplies its own Gemini key + picks its own gemini-*
// model. No central cost. The endpoint base comes from geminiApiBase() (env,
// overridable) — NOT hardcoded — and the model from input.model.
//
// REST contract (https://ai.google.dev/api/generate-content):
//   POST {base}/models/{model}:generateContent?key={apiKey}
//     body: { contents: [{ parts: [ {inline_data:{mime_type,data}}, {text} ] }],
//             generationConfig: { responseMimeType: "application/json" } }
//   resp: { candidates: [{ content: { parts: [{ text: "<json>" }] } }] }
//
// We send the prompt asking for a strict JSON object and parse the model's text
// part back into our VideoAnalysis shape. Tests mock fetch — no live call here.
//
// ASSUMPTION (flagged in the report): inline_data base64 is used for the v1
// our-rendered clips (short-form, comfortably under the inline ~20MB request
// cap). Larger/organic videos would need the resumable Files API — deferred
// with the organic byte-source decision.

import { geminiApiBase } from "@/lib/env";
import {
  type AnalyzeVideoInput,
  type VideoAnalysis,
  type VideoAnalyzer,
  type VisualBreakdown,
  type VisualMoment,
  type HookRating,
  type HookCriterion,
  HOOK_CRITERIA,
  VideoAnalysisError,
} from "./provider";

// The rubric block injected into the prompt — the model grades EXACTLY these
// keys, so its sub-scores line up with HOOK_CRITERIA on the way back. Built from
// the shared rubric so the prompt can never drift from the normaliser.
const CRITERIA_PROMPT = HOOK_CRITERIA.map(
  (c) => `    { "key": "${c.key}", "label": "${c.label}", "score": number /*0-10*/, "reason": string }  // ${c.hint}`,
).join("\n");

// The instruction we hand Gemini. Asks for a STRICT JSON object matching our
// VideoAnalysis-minus-raw shape so parsing is deterministic. Framed as a
// direct-response hook breakdown AND grade (Hormozi: a hook either stops the
// scroll or it doesn't — so describe it AND score it: first 5s, pattern
// interrupts, on-screen text, spoken + visual hooks, plus a 0–100 hook rating).
const ANALYSIS_PROMPT = `You are a direct-response short-form video analyst in the Alex Hormozi school: a hook's only job is to stop the scroll and earn the next 3 seconds. Watch this video and return ONLY a JSON object (no markdown, no prose) with EXACTLY these keys:
{
  "transcript": string,            // the full spoken audio, transcribed
  "hook_spoken": string,           // the spoken hook — the words in the first ~3 seconds
  "hook_visual": string,           // the visual hook — what the eye lands on first
  "visual_breakdown": {
    "firstFiveSeconds": string,    // what is on screen in the first ~5 seconds
    "patternInterrupts": [          // cuts / zooms / scene or subject changes that reset attention
      { "atSeconds": number, "description": string }
    ],
    "onScreenText": [string]        // on-screen text / captions, read verbatim
  },
  "hook_rating": {
    "score": number,               // OVERALL hook strength 0-100 (be a tough grader; reserve 80+ for hooks that genuinely stop the scroll)
    "verdict": string,             // one-line call, e.g. "Strong scroll-stopper, weak CTA"
    "criteria": [                   // grade EACH of these dimensions, 0-10:
${CRITERIA_PROMPT}
    ],
    "improvements": [string]        // 2-4 concrete, actionable fixes to raise the score (rewrites, cuts, overlays)
  }
}
Return valid JSON only.`;

// Gemini's generateContent response envelope (only the fields we read).
interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
}

export class GeminiVideoAnalyzer implements VideoAnalyzer {
  readonly name = "gemini";

  // Gemini owns the "gemini-*" model family. Case-insensitive so "Gemini-2.5"
  // and "gemini-2.5-flash" both route here.
  supportsModel(model: string): boolean {
    return model.trim().toLowerCase().startsWith("gemini");
  }

  private endpoint(model: string): string {
    // geminiApiBase() always has a value (env default), so this is well-formed
    // without the caller knowing the host. Model id is the workspace's choice.
    return `${geminiApiBase()}/models/${encodeURIComponent(model)}:generateContent`;
  }

  async analyze(input: AnalyzeVideoInput): Promise<VideoAnalysis> {
    // ── Validate at the boundary ──────────────────────────────────────────
    if (!input.apiKey || !input.apiKey.trim()) {
      throw new VideoAnalysisError("Gemini analysis requires a BYO API key.");
    }
    if (!input.bytes || input.bytes.length === 0) {
      // v1 is bytes-only (our-rendered videos we own). A videoUrl-only call is
      // the deferred organic path — reject clearly rather than silently no-op.
      throw new VideoAnalysisError(
        "Gemini analysis requires video bytes (the v1 our-rendered path); URL-only is not yet supported.",
      );
    }

    const body = {
      contents: [
        {
          parts: [
            {
              inline_data: {
                mime_type: input.contentType || "video/mp4",
                data: Buffer.from(input.bytes).toString("base64"),
              },
            },
            { text: ANALYSIS_PROMPT },
          ],
        },
      ],
      // Ask for JSON so the text part is parseable without scraping markdown.
      generationConfig: { responseMimeType: "application/json" },
    };

    const res = await fetch(`${this.endpoint(input.model)}?key=${encodeURIComponent(input.apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new VideoAnalysisError(`Gemini analyze failed (${res.status}): ${text.slice(0, 400)}`);
    }

    const json = (await res.json()) as GeminiResponse;

    if (json.promptFeedback?.blockReason) {
      throw new VideoAnalysisError(
        `Gemini blocked the request: ${json.promptFeedback.blockReason}`,
      );
    }

    const partText = json.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!partText || !partText.trim()) {
      throw new VideoAnalysisError("Gemini returned no analysis text.");
    }

    return normalize(partText, json);
  }
}

// Parse Gemini's JSON text part into our VideoAnalysis, defending every field so
// a slightly-off model response can't crash the persist. `raw` keeps the verbatim
// envelope for re-parsing later. Exported for direct unit testing of the parse.
export function normalize(partText: string, raw: unknown): VideoAnalysis {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripCodeFence(partText)) as Record<string, unknown>;
  } catch {
    throw new VideoAnalysisError("Gemini returned text that was not valid JSON.");
  }

  const vbRaw = (parsed.visual_breakdown ?? {}) as Record<string, unknown>;
  const visual_breakdown: VisualBreakdown = {
    firstFiveSeconds: asString(vbRaw.firstFiveSeconds),
    patternInterrupts: asMoments(vbRaw.patternInterrupts),
    onScreenText: asStringArray(vbRaw.onScreenText),
  };

  return {
    transcript: asString(parsed.transcript),
    visual_breakdown,
    hook_spoken: asString(parsed.hook_spoken),
    hook_visual: asString(parsed.hook_visual),
    hook_rating: asRating(parsed.hook_rating),
    raw,
  };
}

// Parse + defend the hook rating. The overall score is clamped to 0–100; each
// returned criterion is matched to the fixed rubric (so an off-label/missing
// dimension still yields a complete, comparable set) with its score clamped to
// 0–10. A wholly-absent rating degrades to a zeroed-but-complete object rather
// than crashing the persist — same defensive contract as the rest of normalize.
function asRating(v: unknown): HookRating {
  const r = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;

  // Index whatever criteria the model returned by rubric key, so we can backfill
  // the full rubric in a stable order regardless of what (or how) it emitted.
  const byKey = new Map<string, HookCriterion>();
  if (Array.isArray(r.criteria)) {
    for (const item of r.criteria) {
      if (item && typeof item === "object") {
        const rec = item as Record<string, unknown>;
        const key = asString(rec.key).trim();
        if (key) {
          byKey.set(key, {
            key,
            label: asString(rec.label),
            score: clamp(rec.score, 0, 10),
            reason: asString(rec.reason),
          });
        }
      }
    }
  }

  // Emit the full rubric in canonical order; backfill the label from the rubric
  // when the model omitted or mangled it, default any missing dimension to 0.
  const criteria: HookCriterion[] = HOOK_CRITERIA.map((spec) => {
    const got = byKey.get(spec.key);
    return {
      key: spec.key,
      label: got?.label?.trim() ? got.label : spec.label,
      score: got ? got.score : 0,
      reason: got?.reason ?? "",
    };
  });

  return {
    score: clamp(r.score, 0, 100),
    verdict: asString(r.verdict),
    criteria,
    improvements: asStringArray(r.improvements),
  };
}

// Coerce an unknown into a finite number clamped to [min, max]; non-numbers → min.
function clamp(v: unknown, min: number, max: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// Some models wrap JSON in a ```json … ``` fence despite the responseMimeType
// request. Strip it defensively before parsing.
function stripCodeFence(s: string): string {
  const trimmed = s.trim();
  if (trimmed.startsWith("```")) {
    return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  }
  return trimmed;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function asMoments(v: unknown): VisualMoment[] {
  if (!Array.isArray(v)) return [];
  const out: VisualMoment[] = [];
  for (const item of v) {
    if (item && typeof item === "object") {
      const rec = item as Record<string, unknown>;
      const description = asString(rec.description);
      if (!description) continue;
      const at = rec.atSeconds;
      out.push({
        description,
        ...(typeof at === "number" && Number.isFinite(at) ? { atSeconds: at } : {}),
      });
    }
  }
  return out;
}

export const geminiVideoAnalyzer = new GeminiVideoAnalyzer();
