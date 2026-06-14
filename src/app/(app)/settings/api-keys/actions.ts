"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getAuthedUserOrRedirect, getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { createApiKey, revokeApiKey } from "@/lib/api/manage";
import { API_SCOPES } from "@/lib/api/keys";

// State carries the freshly-minted raw key ONCE, so the page can reveal it
// immediately after creation and never again (it's not stored anywhere readable).
export type ApiKeysState = {
  error: string | null;
  success: string | null;
  createdKey?: { name: string; raw: string; scopes: string[] } | null;
};

const createSchema = z.object({
  name: z.string().trim().min(1, "Give the key a name.").max(80),
  scopes: z.array(z.enum(API_SCOPES)).min(1, "Select at least one scope."),
});

export async function createApiKeyAction(
  _prev: ApiKeysState,
  formData: FormData,
): Promise<ApiKeysState> {
  const user = await getAuthedUserOrRedirect();
  const ws = await getActiveWorkspaceOrRedirect();

  // Checkboxes arrive as repeated `scopes` entries; getAll collects them.
  const parsed = createSchema.safeParse({
    name: formData.get("name"),
    scopes: formData.getAll("scopes"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input.", success: null, createdKey: null };
  }

  try {
    const svc = await supabaseServer();
    const created = await createApiKey(svc, {
      workspaceId: ws.id,
      name: parsed.data.name,
      scopes: parsed.data.scopes,
      createdBy: user.id,
    });
    revalidatePath("/settings/api-keys");
    return {
      error: null,
      success: `Created "${created.name}". Copy the key now — it won't be shown again.`,
      createdKey: { name: created.name, raw: created.raw, scopes: created.scopes },
    };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Failed to create the API key.",
      success: null,
      createdKey: null,
    };
  }
}

const revokeSchema = z.object({ id: z.string().uuid() });

export async function revokeApiKeyAction(formData: FormData): Promise<void> {
  await getAuthedUserOrRedirect();
  const ws = await getActiveWorkspaceOrRedirect();
  const parsed = revokeSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) return;
  const svc = await supabaseServer();
  await revokeApiKey(svc, ws.id, parsed.data.id);
  revalidatePath("/settings/api-keys");
}
