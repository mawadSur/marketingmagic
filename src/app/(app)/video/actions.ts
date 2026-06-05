"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { videoFeatureConfigured, referenceVideoEnabled, byoKeysConfigured } from "@/lib/env";
import { getActiveWorkspaceOrRedirect, getAuthedUserOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { QuotaExceededError } from "@/lib/billing/limits";
import { getWorkspaceKeyStatus } from "@/lib/video/byo-keys";
import { getAvatar } from "@/lib/video/avatars";
import {
  startVideoRender,
  startReferenceVideoRender,
  VideoRenderError,
} from "@/lib/video/orchestrator";

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

// ─────────────────────────────────────────────────────────────────────────────
// UGC avatar video (Higgsfield) — the user picks a SAVED avatar + types a script,
// and we render a talking-avatar clip via the "present" path (higgsfield_video).
//
// Mirrors generateReferenceVideoAction's contract, but instead of uploading a
// photo it resolves an already-saved avatar (getAvatar, workspace-scoped so a
// foreign id can't be smuggled in) and reuses its stored imageUrl/imagePath as
// the reference. UGC implies the workspace owns the avatar, so consent is set
// true here (and re-enforced in the orchestrator as defence in depth).
// ─────────────────────────────────────────────────────────────────────────────

const ugcSchema = z.object({
  // The saved avatar to speak the script. uuid-checked + workspace-scoped below.
  avatarId: z.string().uuid("Choose an avatar."),
  script: z.string().trim().min(3, "Enter the words the avatar should say.").max(4000),
  // Short caption seed for the eventual draft post; optional.
  videoSubject: z
    .string()
    .trim()
    .max(500)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  // UGC implies the avatar is owned — the checkbox submits "on" when ticked.
  consent: z.literal("on", {
    errorMap: () => ({ message: "Confirm you own this avatar / have the right to use it." }),
  }),
  // Optional destination channel — "" means save to library (no draft post).
  socialAccountId: z
    .string()
    .uuid()
    .optional()
    .or(z.literal("").transform(() => undefined)),
});

export async function generateUgcVideoAction(
  _prev: GenerateVideoState,
  formData: FormData,
): Promise<GenerateVideoState> {
  const user = await getAuthedUserOrRedirect();
  const ws = await getActiveWorkspaceOrRedirect();

  // Gate: the UGC path rides the reference-video pipeline, so it needs both the
  // feature flag and credential encryption (Higgsfield key is stored encrypted).
  if (!referenceVideoEnabled() || !byoKeysConfigured()) {
    return {
      error: "UGC avatar video isn't available on this deployment yet.",
      success: null,
      needsKeys: false,
      quota: false,
    };
  }

  const parsed = ugcSchema.safeParse({
    avatarId: formData.get("avatarId") ?? "",
    script: formData.get("script") ?? "",
    videoSubject: formData.get("videoSubject") ?? "",
    consent: formData.get("consent"),
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

  // Pre-flight the Higgsfield key so we deep-link to settings instead of the
  // orchestrator's generic "no key configured" string.
  const status = await getWorkspaceKeyStatus(ws.id);
  if (!status.higgsfield_video) {
    return {
      error: "Add your Higgsfield key before generating a UGC video.",
      success: null,
      needsKeys: true,
      quota: false,
    };
  }

  // Resolve the avatar, scoped to this workspace so an id from another
  // workspace can't be rendered against.
  const avatar = await getAvatar(ws.id, parsed.data.avatarId);
  if (!avatar) {
    return {
      error: "That avatar doesn't exist in this workspace.",
      success: null,
      needsKeys: false,
      quota: false,
    };
  }

  // Validate the destination channel belongs to this workspace + is connected,
  // exactly like generateVideoAction, so a tampered form can't smuggle another
  // workspace's account onto the job.
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
    await startReferenceVideoRender(ws.id, {
      capability: "present",
      presentProvider: "higgsfield_video",
      referenceImageUrl: avatar.imageUrl,
      referenceImagePath: avatar.imagePath,
      script: parsed.data.script,
      videoSubject: parsed.data.videoSubject,
      videoAspect: "9:16",
      consent: true, // re-enforced in the orchestrator (defence in depth)
      consentBy: user.id,
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
    success: "UGC render started. Track its progress below.",
    needsKeys: false,
    quota: false,
  };
}
