"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { supabaseService } from "@/lib/supabase/service";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { xVerify, type XCredentialsLegacy } from "@/lib/social/x";
import { assertWithinChannelQuota, QuotaExceededError } from "@/lib/billing/limits";

// Manual-paste OAuth 1.0a fallback. Kept alongside the OAuth 2.0 PKCE flow
// because (a) the consent flow can fail on misconfigured X apps and (b) some
// users prefer pasting permanent tokens generated in the X dev portal under
// "Keys and tokens → Access Token and Secret".
//
// Credentials are stored in the same social_accounts.credentials JSONB as
// OAuth 2.0 creds. The API methods discriminate on shape (isLegacyXCreds)
// and branch to the right auth scheme.

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

  const creds: XCredentialsLegacy = parsed.data;
  let username: string;
  try {
    const verified = await xVerify(creds);
    username = verified.username;
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Verification failed.", success: null };
  }

  try {
    await assertWithinChannelQuota(ws.id, { channel: "x", handle: username });
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      return { error: err.message, success: null };
    }
    throw err;
  }

  const svc = supabaseService();
  const { error } = await svc
    .from("social_accounts")
    .upsert(
      {
        workspace_id: ws.id,
        channel: "x",
        handle: username,
        // Cast through Record<string, string> to satisfy the jsonb column type.
        credentials: creds as unknown as Record<string, string>,
        status: "connected",
      },
      { onConflict: "workspace_id,channel,handle" },
    );
  if (error) return { error: error.message, success: null };

  revalidatePath("/settings/channels");
  return { error: null, success: `Connected @${username}.` };
}
