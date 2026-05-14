"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { listWorkspaces, setActiveWorkspaceCookie } from "@/lib/workspace";

const slugSchema = z.string().regex(/^[a-z0-9-]{2,40}$/);
const pathSchema = z
  .string()
  .regex(/^\/[a-zA-Z0-9/_\-]{0,80}$/) // intentionally narrow — only internal paths
  .optional();

/**
 * Switch the active workspace cookie and forward into that workspace's
 * dashboard (or another internal path if supplied). Used by the
 * `/portfolio` workspace cards and the stale-pending alert "Open queue"
 * buttons.
 */
export async function switchAndGoToDashboardAction(formData: FormData): Promise<void> {
  const slug = slugSchema.safeParse(formData.get("slug"));
  if (!slug.success) return;

  const pathRaw = formData.get("path");
  const path = pathRaw ? pathSchema.safeParse(pathRaw) : { success: true, data: undefined as string | undefined };
  const dest = path.success && path.data ? path.data : "/dashboard";

  const workspaces = await listWorkspaces();
  if (!workspaces.some((w) => w.slug === slug.data)) return;

  await setActiveWorkspaceCookie(slug.data);
  redirect(dest);
}
