// Video analysis — pluggable entrypoint + backend dispatch (Hormozi slice 2).
//
// `analyzeVideo(input)` is the single boundary the rest of the app calls. It
// picks the backend that owns the workspace's chosen model family
// (selectAnalyzer) and runs it. BYO-key + user-chosen model, like MPT /
// Higgsfield — no central cost, the provider is configurable per workspace.
//
// Today the only wired backend is Gemini (native-video — the recommended
// default; Claude has no video input type). The dispatch is structured so a
// Claude-frames-or-other backend is a one-line registry add later, without
// touching call sites.

import {
  type AnalyzeVideoInput,
  type VideoAnalysis,
  type VideoAnalyzer,
  VideoAnalysisError,
} from "./provider";
import { geminiVideoAnalyzer } from "./gemini-analyzer";

// The registry of wired backends, in dispatch-priority order. To add a
// Claude-frames (or other) backend later: implement VideoAnalyzer and append it
// here — selectAnalyzer picks the first whose supportsModel() matches.
const ANALYZERS: VideoAnalyzer[] = [geminiVideoAnalyzer];

// Pick the backend that owns the given model family. Exported so the dispatch is
// directly unit-testable (the test asserts a gemini-* model → the gemini
// backend). Throws when no wired backend claims the model — surfacing
// "unsupported model" rather than silently mis-routing.
export function selectAnalyzer(model: string): VideoAnalyzer {
  const trimmed = model?.trim();
  if (!trimmed) {
    throw new VideoAnalysisError("No analysis model specified.");
  }
  const backend = ANALYZERS.find((a) => a.supportsModel(trimmed));
  if (!backend) {
    throw new VideoAnalysisError(
      `No video-analysis backend supports model "${trimmed}". Wired families: gemini-*.`,
    );
  }
  return backend;
}

// Analyse one short-form video → a structured DR hook breakdown. Validates the
// minimal shared input here; each backend re-validates its own specifics.
export async function analyzeVideo(input: AnalyzeVideoInput): Promise<VideoAnalysis> {
  if (!input.apiKey || !input.apiKey.trim()) {
    throw new VideoAnalysisError("analyzeVideo requires a BYO API key.");
  }
  if (!input.bytes?.length && !input.videoUrl) {
    throw new VideoAnalysisError("analyzeVideo requires video bytes or a videoUrl.");
  }
  const backend = selectAnalyzer(input.model);
  return backend.analyze(input);
}

export {
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
