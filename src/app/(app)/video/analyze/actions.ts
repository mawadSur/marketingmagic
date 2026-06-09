"use server";

import { z } from "zod";
import { byoKeysConfigured } from "@/lib/env";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { analyzePostVideo } from "@/lib/video/analyze/run";
import { VideoAnalysisError, type VideoAnalysis } from "@/lib/video/analyze";

// On-demand "Analyze hook" trigger (Hormozi slice 2, v1). Auth + workspace are
// resolved here; the heavy lifting (load bytes → BYO-key analyze → upsert) lives
// in lib/video/analyze/run.ts. `needsKeys` lets the UI show a "set up your
// analysis key" link instead of a raw error.
export type AnalyzeHookState = {
  error: string | null;
  analysis: VideoAnalysis | null;
  provider: string | null;
  model: string | null;
  needsKeys: boolean;
};

const schema = z.object({ postId: z.string().uuid("Invalid post id.") });

export async function analyzeHookAction(
  _prev: AnalyzeHookState,
  formData: FormData,
): Promise<AnalyzeHookState> {
  const ws = await getActiveWorkspaceOrRedirect();

  if (!byoKeysConfigured()) {
    return {
      error: "Analysis isn't available on this deployment (BYO_ENCRYPTION_KEY is unset).",
      analysis: null,
      provider: null,
      model: null,
      needsKeys: false,
    };
  }

  const parsed = schema.safeParse({ postId: formData.get("postId") });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
      analysis: null,
      provider: null,
      model: null,
      needsKeys: false,
    };
  }

  try {
    const result = await analyzePostVideo(ws.id, parsed.data.postId);
    return {
      error: null,
      analysis: result.analysis,
      provider: result.provider,
      model: result.model,
      needsKeys: false,
    };
  } catch (err) {
    const message =
      err instanceof VideoAnalysisError
        ? err.message
        : err instanceof Error
          ? err.message
          : "Analysis failed.";
    // Surface the "no analysis key" case as a setup nudge, not a dead-end error.
    const needsKeys = err instanceof VideoAnalysisError && /no analysis key/i.test(message);
    return { error: message, analysis: null, provider: null, model: null, needsKeys };
  }
}
