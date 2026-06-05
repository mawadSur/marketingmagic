"use server";

// UGC avatars (Higgsfield path) — server actions for the avatar manager.
//
// A workspace's reusable presenter portraits. Mirrors the reference-image upload
// pattern (settings/reference-video/actions.ts): validate mime + size at the
// boundary, write under a workspace-prefixed path with the service-role client,
// then record the row via the avatars data layer.
//
// Hard-gated by referenceVideoEnabled(): with the flag off every action refuses,
// so no upload or mutation happens and the feature stays dark.

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { referenceVideoEnabled } from "@/lib/env";
import { getAuthedUserOrRedirect, getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseService } from "@/lib/supabase/service";
import { createAvatar, setPrimaryAvatar, deleteAvatar } from "@/lib/video/avatars";

export type AvatarState = { error: string | null; success: string | null };

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_BYTES = 10 * 1024 * 1024; // 10MB — matches the bucket cap in 030.

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const MAX_NAME = 80;

// Upload a portrait to the reference-image bucket, then record an avatar row.
export async function uploadAvatarAction(
  _prev: AvatarState,
  formData: FormData,
): Promise<AvatarState> {
  // Flag gate first — nothing ships live.
  if (!referenceVideoEnabled()) {
    return { error: "Avatars aren't enabled on this deployment yet.", success: null };
  }

  const user = await getAuthedUserOrRedirect();
  const ws = await getActiveWorkspaceOrRedirect();

  const rawName = formData.get("name");
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name) {
    return { error: "Give this avatar a name.", success: null };
  }
  if (name.length > MAX_NAME) {
    return { error: `Name must be ${MAX_NAME} characters or fewer.`, success: null };
  }

  const file = formData.get("reference_image");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Choose a portrait to upload.", success: null };
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
  const { data: pub } = svc.storage.from("reference-image").getPublicUrl(path);

  try {
    await createAvatar({
      workspaceId: ws.id,
      name,
      imagePath: path,
      imageUrl: pub.publicUrl,
      createdBy: user.id,
    });
  } catch (err) {
    // Best-effort cleanup so a failed insert doesn't strand the object.
    await svc.storage.from("reference-image").remove([path]).catch(() => {});
    return {
      error: err instanceof Error ? err.message : "Failed to save avatar.",
      success: null,
    };
  }

  revalidatePath("/settings/avatars");
  return { error: null, success: `Saved "${name}".` };
}

// Make the chosen avatar the workspace's primary.
export async function setPrimaryAvatarAction(formData: FormData): Promise<void> {
  if (!referenceVideoEnabled()) return;
  await getAuthedUserOrRedirect();
  const ws = await getActiveWorkspaceOrRedirect();

  const avatarId = formData.get("avatar_id");
  if (typeof avatarId !== "string" || !avatarId) return;

  await setPrimaryAvatar(ws.id, avatarId);
  revalidatePath("/settings/avatars");
}

// Delete an avatar (row + underlying portrait object).
export async function deleteAvatarAction(formData: FormData): Promise<void> {
  if (!referenceVideoEnabled()) return;
  await getAuthedUserOrRedirect();
  const ws = await getActiveWorkspaceOrRedirect();

  const avatarId = formData.get("avatar_id");
  if (typeof avatarId !== "string" || !avatarId) return;

  await deleteAvatar(ws.id, avatarId);
  revalidatePath("/settings/avatars");
}
