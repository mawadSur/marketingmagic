// UGC avatars — data layer (service-role).
//
// A workspace's reusable presenter portraits for the Higgsfield UGC workflow.
// The portrait bytes live in the `reference-image` bucket (migration 030); this
// module owns the `avatars` table (039) that names + indexes them so a workspace
// can pick a saved avatar instead of re-uploading every render.
//
// Consumed by:
//   - the avatar manager UI (upload/select/set-primary/delete) — settings,
//   - the /video UGC tab (pick an avatar to render against),
//   - the planner (resolveUgcAvatar → pre-populate UGC renders so the user just
//     approves).
//
// Writes go through the service role (RLS allows member SELECT only). Callers
// must do their own auth/workspace gating before invoking the write helpers.

import { supabaseService } from "@/lib/supabase/service";
import type { UgcAvatar } from "@/lib/video/ugc-plan";

export interface AvatarRecord {
  id: string;
  workspaceId: string;
  name: string;
  imagePath: string;
  imageUrl: string;
  isPrimary: boolean;
  createdAt: string;
}

interface AvatarRow {
  id: string;
  workspace_id: string;
  name: string;
  image_path: string;
  image_url: string;
  is_primary: boolean;
  created_at: string;
}

function toRecord(row: AvatarRow): AvatarRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    imagePath: row.image_path,
    imageUrl: row.image_url,
    isPrimary: row.is_primary,
    createdAt: row.created_at,
  };
}

// List a workspace's avatars, primary first then newest. Empty array when none.
export async function listAvatars(workspaceId: string): Promise<AvatarRecord[]> {
  const svc = supabaseService();
  const { data, error } = await svc
    .from("avatars")
    .select("id, workspace_id, name, image_path, image_url, is_primary, created_at")
    .eq("workspace_id", workspaceId)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listAvatars failed: ${error.message}`);
  return (data ?? []).map((r) => toRecord(r as AvatarRow));
}

// Fetch one avatar, scoped to the workspace (so an id from another workspace
// can't be resolved). Null when not found.
export async function getAvatar(
  workspaceId: string,
  avatarId: string,
): Promise<AvatarRecord | null> {
  const svc = supabaseService();
  const { data, error } = await svc
    .from("avatars")
    .select("id, workspace_id, name, image_path, image_url, is_primary, created_at")
    .eq("workspace_id", workspaceId)
    .eq("id", avatarId)
    .maybeSingle();
  if (error) throw new Error(`getAvatar failed: ${error.message}`);
  return data ? toRecord(data as AvatarRow) : null;
}

// Create an avatar row for an already-uploaded portrait (the caller uploads the
// bytes to the reference-image bucket, then records the path + public URL here).
// `makePrimary` (default true when it's the workspace's first avatar) flips any
// existing primary off first so the partial-unique index never collides.
export async function createAvatar(input: {
  workspaceId: string;
  name: string;
  imagePath: string;
  imageUrl: string;
  createdBy?: string | null;
  makePrimary?: boolean;
}): Promise<AvatarRecord> {
  const svc = supabaseService();

  // First avatar is primary by default; otherwise honour the explicit flag.
  const existing = await listAvatars(input.workspaceId);
  const makePrimary = input.makePrimary ?? existing.length === 0;
  if (makePrimary && existing.some((a) => a.isPrimary)) {
    await svc.from("avatars").update({ is_primary: false }).eq("workspace_id", input.workspaceId);
  }

  const { data, error } = await svc
    .from("avatars")
    .insert({
      workspace_id: input.workspaceId,
      name: input.name.trim() || "Avatar",
      image_path: input.imagePath,
      image_url: input.imageUrl,
      is_primary: makePrimary,
      created_by: input.createdBy ?? null,
    })
    .select("id, workspace_id, name, image_path, image_url, is_primary, created_at")
    .single();
  if (error || !data) throw new Error(`createAvatar failed: ${error?.message ?? "no row"}`);
  return toRecord(data as AvatarRow);
}

// Make `avatarId` the workspace's primary avatar (flips the old one off first).
// No-op-safe: scoped to the workspace so a foreign id changes nothing.
export async function setPrimaryAvatar(workspaceId: string, avatarId: string): Promise<void> {
  const svc = supabaseService();
  await svc.from("avatars").update({ is_primary: false }).eq("workspace_id", workspaceId);
  const { error } = await svc
    .from("avatars")
    .update({ is_primary: true })
    .eq("workspace_id", workspaceId)
    .eq("id", avatarId);
  if (error) throw new Error(`setPrimaryAvatar failed: ${error.message}`);
}

// Delete an avatar row + its underlying portrait object (best-effort on the
// storage delete — a dangling object is harmless, a dangling row is not).
export async function deleteAvatar(workspaceId: string, avatarId: string): Promise<void> {
  const svc = supabaseService();
  const avatar = await getAvatar(workspaceId, avatarId);
  if (!avatar) return;
  await svc.from("avatars").delete().eq("workspace_id", workspaceId).eq("id", avatarId);
  // Best-effort storage cleanup — never throw on a missing object.
  await svc.storage
    .from("reference-image")
    .remove([avatar.imagePath])
    .catch(() => {});
}

// Resolve the avatar the planner should pre-populate UGC renders from: an
// explicit id if given, else the workspace's primary, else the most recent.
// Returns the UgcAvatar shape (url + path) buildUgcRenderInput expects, or null
// when the workspace has no avatars (planner then skips UGC for that run).
export async function resolveUgcAvatar(
  workspaceId: string,
  preferredAvatarId?: string | null,
): Promise<UgcAvatar | null> {
  if (preferredAvatarId) {
    const chosen = await getAvatar(workspaceId, preferredAvatarId);
    if (chosen) return { imageUrl: chosen.imageUrl, imagePath: chosen.imagePath };
  }
  const all = await listAvatars(workspaceId); // primary-first, then newest
  const pick = all[0];
  return pick ? { imageUrl: pick.imageUrl, imagePath: pick.imagePath } : null;
}
