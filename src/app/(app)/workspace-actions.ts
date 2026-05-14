"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { listWorkspaces, setActiveWorkspaceCookie } from "@/lib/workspace";
import { bumpRecent, togglePin } from "@/lib/workspace-prefs";

const slugSchema = z.string().regex(/^[a-z0-9-]{2,40}$/);
const uuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

export async function switchWorkspaceAction(slug: string) {
  const parsed = slugSchema.safeParse(slug);
  if (!parsed.success) return;
  const workspaces = await listWorkspaces();
  const target = workspaces.find((w) => w.slug === parsed.data);
  if (!target) return;
  await setActiveWorkspaceCookie(parsed.data);
  // Bump the recent-workspaces cookie so the next cmd-K render orders
  // it correctly. Doesn't matter if this fails — it's a UX nicety.
  await bumpRecent(target.id);
  revalidatePath("/", "layout");
}

/**
 * Toggle pin state for a workspace. Pins float to the top of the cmd-K
 * palette ahead of recent and unpinned workspaces. The toggle is
 * idempotent — pinning an already-pinned workspace unpins it.
 *
 * Validated against the caller's workspace list to prevent pinning a
 * workspace the user doesn't have access to.
 */
export async function toggleWorkspacePinAction(workspaceId: string) {
  const parsed = uuidSchema.safeParse(workspaceId);
  if (!parsed.success) return;
  const workspaces = await listWorkspaces();
  if (!workspaces.some((w) => w.id === parsed.data)) return;
  await togglePin(parsed.data);
  revalidatePath("/", "layout");
}
