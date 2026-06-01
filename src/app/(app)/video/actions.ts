"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { videoFeatureConfigured } from "@/lib/env";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { QuotaExceededError } from "@/lib/billing/limits";
import { getWorkspaceKeyStatus } from "@/lib/video/byo-keys";
import { startVideoRender, VideoRenderError } from "@/lib/video/orchestrator";

// `needsKeys` lets the client show a "set up your keys" link instead of a raw
// error when BYO credentials are missing; `quota` flags the upgrade nudge.
export type GenerateVideoState = {
  error: string | null;
  success: string | null;
  needsKeys: boolean;
  quota: boolean;
};

const schema = z.object({
  videoSubject: z.string().trim().min(3, "Subject must be at least 3 characters.").max(500),
  videoScript: z
    .string()
    .trim()
    .max(5000)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  videoAspect: z.enum(["9:16", "16:9", "1:1"]).default("9:16"),
  voiceName: z
    .string()
    .trim()
    .max(120)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  // Optional destination channel — "" means save to library (no draft post).
  socialAccountId: z
    .string()
    .uuid()
    .optional()
    .or(z.literal("").transform(() => undefined)),
});

export async function generateVideoAction(
  _prev: GenerateVideoState,
  formData: FormData,
): Promise<GenerateVideoState> {
  const ws = await getActiveWorkspaceOrRedirect();

  if (!videoFeatureConfigured()) {
    return {
      error: "Video generation isn't available on this deployment.",
      success: null,
      needsKeys: false,
      quota: false,
    };
  }

  const parsed = schema.safeParse({
    videoSubject: formData.get("videoSubject"),
    videoScript: formData.get("videoScript") ?? "",
    videoAspect: formData.get("videoAspect") ?? "9:16",
    voiceName: formData.get("voiceName") ?? "",
    socialAccountId: formData.get("socialAccountId") ?? "",
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
      success: null,
      needsKeys: false,
      quota: false,
    };
  }

  // Pre-flight the BYO keys so we can deep-link to settings instead of
  // surfacing the orchestrator's generic "no key configured" string.
  const status = await getWorkspaceKeyStatus(ws.id);
  if (!status.llm || !status.pexels) {
    return {
      error: "Add your LLM and Pexels keys before generating a video.",
      success: null,
      needsKeys: true,
      quota: false,
    };
  }

  // Validate the chosen destination belongs to this workspace (RLS-scoped) and
  // is connected. An invalid id is rejected rather than silently dropped so a
  // tampered form can't smuggle another workspace's account onto the job.
  let socialAccountId: string | undefined;
  if (parsed.data.socialAccountId) {
    const supabase = await supabaseServer();
    const { data: account } = await supabase
      .from("social_accounts_safe")
      .select("id")
      .eq("id", parsed.data.socialAccountId)
      .eq("workspace_id", ws.id)
      .eq("status", "connected")
      .maybeSingle();
    if (!account) {
      return {
        error: "That channel isn't connected to this workspace.",
        success: null,
        needsKeys: false,
        quota: false,
      };
    }
    socialAccountId = account.id;
  }

  try {
    await startVideoRender(ws.id, {
      videoSubject: parsed.data.videoSubject,
      videoScript: parsed.data.videoScript,
      videoAspect: parsed.data.videoAspect,
      voiceName: parsed.data.voiceName,
      socialAccountId,
    });
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      return { error: err.message, success: null, needsKeys: false, quota: true };
    }
    if (err instanceof VideoRenderError) {
      return { error: err.message, success: null, needsKeys: false, quota: false };
    }
    return {
      error: err instanceof Error ? err.message : "Failed to start render.",
      success: null,
      needsKeys: false,
      quota: false,
    };
  }

  revalidatePath("/video");
  return {
    error: null,
    success: "Render started. Track its progress below.",
    needsKeys: false,
    quota: false,
  };
}
