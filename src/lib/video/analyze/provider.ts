// Video analysis — vendor-neutral provider contract (Hormozi slice 2).
//
// This is the pluggable boundary for the NEW "analyze a short-form video and
// produce a direct-response hook breakdown" path. It is deliberately abstract
// so a concrete backend (Gemini native-video — recommended default; a
// Claude-frames or other backend later) can be dropped in WITHOUT touching call
// sites — exactly how src/lib/video/reference/provider.ts abstracts fal vs. a
// future adapter.
//
// KEY PRODUCT DECISION: BYO-key + user-chooses-their-own-model (like MPT /
// Higgsfield). There is NO central API cost; the workspace supplies its own key
// and picks its own model. `selectAnalyzer(model)` dispatches to the backend
// that owns that model family. Claude has NO video input type (frames-only,
// loses the temporal first-5s signal); Gemini ingests video natively and is the
// recommended default.
//
// Nothing here makes a live external call. Concrete adapters fetch; tests mock
// fetch and never hit the network.

// The video to analyse + the BYO credentials/model the workspace chose. The
// caller provides EITHER raw bytes (our-rendered videos we own in the
// post-media-video bucket — v1 scope) OR a URL (deferred organic path). A
// concrete adapter uses whichever it can.
export interface AnalyzeVideoInput {
  // Raw mp4 bytes — the v1 path (we own these in storage). One of bytes/videoUrl
  // must be present.
  bytes?: Uint8Array;
  // MIME of the bytes (defaults to video/mp4). Native-video backends need this.
  contentType?: string;
  // Public/CDN URL of the video — the deferred organic path. One of
  // bytes/videoUrl must be present.
  videoUrl?: string;
  // The workspace's BYO analysis-provider API key (decrypted, service-role).
  apiKey: string;
  // The model the workspace chose (e.g. "gemini-2.5-flash"). Drives BOTH the
  // backend dispatch (selectAnalyzer) and the request the adapter sends.
  model: string;
}

// A single annotated visual moment in the clip. Timestamps are seconds from the
// start when the backend reports them (Gemini does); else omitted.
export interface VisualMoment {
  // Seconds from start, when known.
  atSeconds?: number;
  // What is on screen / what changes here (a pattern interrupt, a cut, a zoom).
  description: string;
}

// The structured visual annotation. Shape is owned HERE (not the DB) so every
// backend normalises to the same object before it's persisted as jsonb.
export interface VisualBreakdown {
  // What's on screen in the first ~5 seconds (the make-or-break window).
  firstFiveSeconds: string;
  // Notable pattern interrupts (cuts, zooms, scene/subject changes) that reset
  // attention — Hormozi's core retention mechanic.
  patternInterrupts: VisualMoment[];
  // On-screen text / captions read off the frames (OCR). Verbatim-ish.
  onScreenText: string[];
}

// One graded dimension of the hook. The rubric is fixed (see HOOK_CRITERIA) so
// scores are comparable across clips and over time; `key` ties a returned score
// back to a known criterion, `label` is the human name, `score` is 0–10.
export interface HookCriterion {
  // Stable rubric id (e.g. "scroll_stop"). Lets the UI/consumer map a returned
  // score to a known dimension regardless of the order the model emits them.
  key: string;
  // Human-readable name of the dimension (e.g. "Scroll-stop power").
  label: string;
  // This dimension's score, 0–10 (clamped on normalise).
  score: number;
  // One-line justification for the score — what earned/cost the points.
  reason: string;
}

// A direct-response GRADE of the hook (Hormozi: a hook either stops the scroll
// or it doesn't — so score it, don't just describe it). `score` is the headline
// 0–100; `criteria` are the per-dimension sub-scores; `verdict` is a one-line
// call; `improvements` are concrete, actionable rewrites/changes to raise the
// score. This is the "rating" the analyzer produces alongside the breakdown.
export interface HookRating {
  // Overall hook strength, 0–100 (clamped on normalise). Higher = stronger.
  score: number;
  // One-line verdict (e.g. "Strong scroll-stopper, weak CTA").
  verdict: string;
  // Per-dimension sub-scores against the fixed rubric.
  criteria: HookCriterion[];
  // Concrete, actionable fixes to raise the score (rewrites, cuts, overlays).
  improvements: string[];
}

// The fixed direct-response hook rubric (Hormozi's first-3-seconds mechanics).
// ONE source of truth, shared by the prompt (so the model knows what to grade)
// and the normaliser (so it can backfill labels + default any missing
// dimension). Keep keys stable — they're persisted and compared over time.
export const HOOK_CRITERIA: ReadonlyArray<{ key: string; label: string; hint: string }> = [
  { key: "scroll_stop", label: "Scroll-stop power", hint: "Does the first frame + first words make a thumb stop?" },
  { key: "clarity", label: "Clarity of promise", hint: "Is it instantly clear what the viewer gets by staying?" },
  { key: "curiosity", label: "Curiosity / tension", hint: "Is there an open loop that demands resolution?" },
  { key: "specificity", label: "Specificity", hint: "Concrete numbers/claims vs. vague generalities?" },
  { key: "callout", label: "Audience call-out", hint: "Does it signal exactly who this is for?" },
];

// The structured output every analyzer returns. Persisted 1:1 into
// video_analysis (transcript, visual_breakdown, hook_spoken, hook_visual,
// hook_rating) plus the verbatim `raw` for re-parsing.
export interface VideoAnalysis {
  transcript: string;
  visual_breakdown: VisualBreakdown;
  // The spoken hook — the words in the opening seconds.
  hook_spoken: string;
  // The visual hook — what the eye lands on first.
  hook_visual: string;
  // The graded hook-strength rating (overall score + rubric + fixes).
  hook_rating: HookRating;
  // Verbatim provider response, kept so a row can be re-parsed without re-charge.
  raw: unknown;
}

// The contract every analysis backend implements. `name` is recorded as the
// `provider` on the persisted row. `supportsModel` lets selectAnalyzer pick the
// backend that owns a given model family without the dispatcher hardcoding lists.
export interface VideoAnalyzer {
  readonly name: string;
  // Does this backend handle the given model id? (e.g. Gemini owns "gemini-*").
  supportsModel(model: string): boolean;
  // Run one analysis pass. Validates its own input at the boundary and throws a
  // VideoAnalysisError on a config/transport/parse failure.
  analyze(input: AnalyzeVideoInput): Promise<VideoAnalysis>;
}

// Thrown for any analysis failure (bad input, no backend for the model, a
// provider/transport/parse error). Distinct type so call sites can branch on
// "analysis failed" vs. a generic error — same idea as ByoKeyConfigError.
export class VideoAnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoAnalysisError";
  }
}
