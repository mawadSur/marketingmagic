"use server";

// SPIKE — Reference-image video (bet ④) · upload server action.
//
// Uploads a user's reference photo to the workspace-scoped `reference-image`
// bucket (migration 030). Mirrors the org-branding logo upload pattern
// (settings/organization/branding/actions.ts): validate mime + size at the
// boundary, write under a workspace-prefixed path with the service-role client.
//
// Hard-gated by referenceVideoEnabled(): with the flag off the action refuses,
// so no upload happens and the feature stays dark. No external provider call is
// made here — that's a later build once a vendor adapter is wired.

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { byoKeysConfigured, referenceVideoEnabled } from "@/lib/env";
import { getAuthedUserOrRedirect, getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseService } from "@/lib/supabase/service";
import {
  setWorkspaceKeys,
  removeWorkspaceKeys,
  type ByoFalVideoSecrets,
} from "@/lib/video/byo-keys";
import {
  startReferenceVideoRender,
  VideoRenderError,
} from "@/lib/video/orchestrator";
import { QuotaExceededError } from "@/lib/billing/limits";

export type ReferenceVideoState = { error: string | null; success: string | null };

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_BYTES = 10 * 1024 * 1024; // 10MB — matches the bucket cap in 030.

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export async function uploadReferenceImageAction(
  _prev: ReferenceVideoState,
  formData: FormData,
): Promise<ReferenceVideoState> {
  // Flag gate first — nothing ships live.
  if (!referenceVideoEnabled()) {
    return {
      error: "Reference-image video isn't enabled on this deployment yet.",
      success: null,
    };
  }

  await getAuthedUserOrRedirect();
  const ws = await getActiveWorkspaceOrRedirect();

  const file = formData.get("reference_image");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Choose a photo to upload.", success: null };
  }
  if (file.size > MAX_BYTES) {
    return { error: "Image must be 10MB or smaller.", success: null };
  }
  if (!ALLOWED_MIME.has(file.type)) {
    return { error: "Image must be JPEG, PNG, or WebP.", success: null };
  }

  const ext = EXT_BY_MIME[file.type] ?? "jpg";
  // Workspace-prefixed so the bucket RLS (split_part(name,'/',1)) authorizes it.
  const path = `${ws.id}/${randomUUID()}/reference.${ext}`;
  const bytes = new Uint8Array(await file.arrayBuffer());

  const svc = supabaseService();
  const { error: upErr } = await svc.storage
    .from("reference-image")
    .upload(path, bytes, { contentType: file.type, upsert: false });
  if (upErr) {
    return { error: `Upload failed: ${upErr.message}`, success: null };
  }

  revalidatePath("/settings/reference-video");
  return { error: null, success: "Reference photo uploaded." };
}

// ─────────────────────────────────────────────────────────────────────────────
// BYO fal video key — save / remove.
//
// Mirrors the LLM/Pexels key forms in settings/video-keys/actions.ts: validate
// at the boundary, store ENCRYPTED via setWorkspaceKeys (never echoed back),
// only Replace or Remove. Gated by both the feature flag AND byoKeysConfigured()
// (without the encryption key, setWorkspaceKeys would throw).
// ─────────────────────────────────────────────────────────────────────────────

const falKeySchema = z.object({
  // fal keys look like "<id>:<secret>"; length-checked, never echoed back.
  api_key: z.string().trim().min(8, "API key looks too short.").max(400),
});

async function keyGuard(): Promise<
  { workspaceId: string; userId: string } | { error: string }
> {
  if (!referenceVideoEnabled()) {
    return { error: "Reference-image video isn't enabled on this deployment yet." };
  }
  const user = await getAuthedUserOrRedirect();
  const ws = await getActiveWorkspaceOrRedirect();
  if (!byoKeysConfigured()) {
    return { error: "Video keys are not available on this deployment (BYO_ENCRYPTION_KEY is unset)." };
  }
  return { workspaceId: ws.id, userId: user.id };
}

export async function saveFalVideoKeyAction(
  _prev: ReferenceVideoState,
  formData: FormData,
): Promise<ReferenceVideoState> {
  const auth = await keyGuard();
  if ("error" in auth) return { error: auth.error, success: null };

  const parsed = falKeySchema.safeParse({ api_key: formData.get("api_key") });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input.", success: null };
  }

  const secrets: ByoFalVideoSecrets = { api_key: parsed.data.api_key };
  try {
    await setWorkspaceKeys(auth.workspaceId, "fal_video", secrets, auth.userId);
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Failed to save fal video key.",
      success: null,
    };
  }

  revalidatePath("/settings/reference-video");
  return { error: null, success: "fal video key saved." };
}

export async function removeFalVideoKeyAction(): Promise<void> {
  const auth = await keyGuard();
  if ("error" in auth) return;
  await removeWorkspaceKeys(auth.workspaceId, "fal_video");
  revalidatePath("/settings/reference-video");
}

// ─────────────────────────────────────────────────────────────────────────────
// Generate — upload the reference photo AND kick off a render in one action.
//
// Validates the photo (mime/size), uploads it to the workspace-scoped
// reference-image bucket, then calls startReferenceVideoRender with the prompt,
// aspect, duration, and the REQUIRED consent checkbox. The orchestrator enforces
// consent (throws if not true) and stores consent_attested_at + consent_by.
// ─────────────────────────────────────────────────────────────────────────────

const ASPECTS = ["9:16", "16:9", "1:1"] as const;

const generateSchema = z.object({
  prompt: z.string().trim().min(3, "Describe the motion you want.").max(1000),
  aspect: z.enum(ASPECTS).default("9:16"),
  duration_seconds: z.coerce.number().int().min(1).max(60).optional(),
  // The consent checkbox submits "on" when checked, nothing when unchecked.
  consent: z.literal("on", { errorMap: () => ({ message: "You must confirm consent to continue." }) }),
});

export async function generateReferenceVideoAction(
  _prev: ReferenceVideoState,
  formData: FormData,
): Promise<ReferenceVideoState> {
  if (!referenceVideoEnabled()) {
    return { error: "Reference-image video isn't enabled on this deployment yet.", success: null };
  }

  const user = await getAuthedUserOrRedirect();
  const ws = await getActiveWorkspaceOrRedirect();

  // Validate the non-file fields first so a missing consent box fails fast.
  const parsed = generateSchema.safeParse({
    prompt: formData.get("prompt"),
    aspect: formData.get("aspect") ?? "9:16",
    duration_seconds: formData.get("duration_seconds") || undefined,
    consent: formData.get("consent"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input.", success: null };
  }

  // Validate + upload the photo.
  const file = formData.get("reference_image");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Choose a photo to animate.", success: null };
  }
  if (file.size > MAX_BYTES) {
    return { error: "Image must be 10MB or smaller.", success: null };
  }
  if (!ALLOWED_MIME.has(file.type)) {
    return { error: "Image must be JPEG, PNG, or WebP.", success: null };
  }

  const ext = EXT_BY_MIME[file.type] ?? "jpg";
  const path = `${ws.id}/${randomUUID()}/reference.${ext}`;
  const bytes = new Uint8Array(await file.arrayBuffer());

  const svc = supabaseService();
  const { error: upErr } = await svc.storage
    .from("reference-image")
    .upload(path, bytes, { contentType: file.type, upsert: false });
  if (upErr) {
    return { error: `Upload failed: ${upErr.message}`, success: null };
  }
  const { data: pub } = svc.storage.from("reference-image").getPublicUrl(path);

  try {
    await startReferenceVideoRender(ws.id, {
      referenceImageUrl: pub.publicUrl,
      referenceImagePath: path,
      prompt: parsed.data.prompt,
      videoAspect: parsed.data.aspect,
      durationSeconds: parsed.data.duration_seconds,
      consent: true, // enforced again in the orchestrator (defence in depth)
      consentBy: user.id,
    });
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      return { error: "You've hit your video quota for this plan. Upgrade to render more.", success: null };
    }
    if (err instanceof VideoRenderError) {
      return { error: err.message, success: null };
    }
    return { error: err instanceof Error ? err.message : "Failed to start render.", success: null };
  }

  revalidatePath("/settings/reference-video");
  return { error: null, success: "Render started — your video will appear in the approval queue when ready." };
}
