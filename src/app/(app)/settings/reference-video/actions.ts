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
import { referenceVideoEnabled } from "@/lib/env";
import { getAuthedUserOrRedirect, getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseService } from "@/lib/supabase/service";

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
