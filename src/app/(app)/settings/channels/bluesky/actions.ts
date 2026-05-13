"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { supabaseService } from "@/lib/supabase/service";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { blueskyVerify, type BlueskyCredentials } from "@/lib/social/bluesky";

export type ConnectBlueskyState = { error: string | null; success: string | null };

const schema = z.object({
  handle: z
    .string()
    .trim()
    .min(3)
    .max(253)
    // Bluesky handles look like "name.bsky.social" or custom domains.
    .regex(/^[a-z0-9.-]+$/i, "Handle must be a valid domain (e.g. you.bsky.social)."),
  appPassword: z.string().trim().min(8),
});

export async function connectBlueskyAction(
  _prev: ConnectBlueskyState,
  formData: FormData,
): Promise<ConnectBlueskyState> {
  const ws = await getActiveWorkspaceOrRedirect();
  const parsed = schema.safeParse({
    handle: formData.get("handle"),
    appPassword: formData.get("appPassword"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input.", success: null };
  }

  const creds: BlueskyCredentials = parsed.data;
  try {
    await blueskyVerify(creds);
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Bluesky verification failed.",
      success: null,
    };
  }

  const svc = supabaseService();
  const { error } = await svc.from("social_accounts").upsert(
    {
      workspace_id: ws.id,
      channel: "bluesky",
      handle: creds.handle,
      credentials: creds as unknown as Record<string, string>,
      status: "connected",
    },
    { onConflict: "workspace_id,channel,handle" },
  );
  if (error) return { error: error.message, success: null };

  revalidatePath("/settings/channels");
  return { error: null, success: `Connected ${creds.handle}.` };
}
