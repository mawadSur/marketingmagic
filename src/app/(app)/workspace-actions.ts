"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { listWorkspaces, setActiveWorkspaceCookie } from "@/lib/workspace";

const slugSchema = z.string().regex(/^[a-z0-9-]{2,40}$/);

export async function switchWorkspaceAction(slug: string) {
  const parsed = slugSchema.safeParse(slug);
  if (!parsed.success) return;
  const workspaces = await listWorkspaces();
  if (!workspaces.some((w) => w.slug === parsed.data)) return;
  await setActiveWorkspaceCookie(parsed.data);
  revalidatePath("/", "layout");
}
