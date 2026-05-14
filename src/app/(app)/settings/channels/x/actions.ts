"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { supabaseService } from "@/lib/supabase/service";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { xVerify, type XConnectionMethod, type XCredentials } from "@/lib/social/x";
import { assertWithinChannelQuota, QuotaExceededError } from "@/lib/billing/limits";

export type ConnectXState = { error: string | null; success: string | null };

const schema = z.object({
  apiKey: z.string().trim().min(8),
  apiSecret: z.string().trim().min(8),
  accessToken: z.string().trim().min(8),
  accessTokenSecret: z.string().trim().min(8),
});

export async function connectXAction(
  _prev: ConnectXState,
  formData: FormData,
): Promise<ConnectXState> {
  const ws = await getActiveWorkspaceOrRedirect();
  const parsed = schema.safeParse({
    apiKey: formData.get("apiKey"),
    apiSecret: formData.get("apiSecret"),
    accessToken: formData.get("accessToken"),
    accessTokenSecret: formData.get("accessTokenSecret"),
  });
  if (!parsed.success) {
    return { error: "All four fields are required.", success: null };
  }

  const creds: XCredentials = parsed.data;
  let username: string;
  try {
    const verified = await xVerify(creds);
    username = verified.username;
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Verification failed.", success: null };
  }

  // Plan-gating: hobby tier caps channels at 1. A user re-upserting an
  // already-connected handle is treated as a reconnect and allowed through.
  try {
    await assertWithinChannelQuota(ws.id, { channel: "x", handle: username });
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      return { error: err.message, success: null };
    }
    throw err;
  }

  // Service-role write — RLS members can insert but the credentials column should
  // only ever round-trip through the server. Use service to keep the principle consistent.
  // Tag with connection_method: "manual" so the settings UI can nudge legacy
  // users toward the OAuth re-auth path.
  const persisted: XCredentials & { connection_method: XConnectionMethod } = {
    ...creds,
    connection_method: "manual",
  };
  const svc = supabaseService();
  const { error } = await svc
    .from("social_accounts")
    .upsert(
      {
        workspace_id: ws.id,
        channel: "x",
        handle: username,
        credentials: persisted as unknown as Record<string, string>,
        status: "connected",
      },
      { onConflict: "workspace_id,channel,handle" },
    );
  if (error) return { error: error.message, success: null };

  revalidatePath("/settings/channels");
  return { error: null, success: `Connected @${username}.` };
}
