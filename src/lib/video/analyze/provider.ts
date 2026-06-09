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

// The structured output every analyzer returns. Persisted 1:1 into
// video_analysis (transcript, visual_breakdown, hook_spoken, hook_visual) plus
// the verbatim `raw` for re-parsing.
export interface VideoAnalysis {
  transcript: string;
  visual_breakdown: VisualBreakdown;
  // The spoken hook — the words in the opening seconds.
  hook_spoken: string;
  // The visual hook — what the eye lands on first.
  hook_visual: string;
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
