"use server";

import { revalidatePath } from "next/cache";
import { supabaseService } from "@/lib/supabase/service";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";

type ActionResult = { error: string | null };

// Toggle the "Made with marketingmagic" attribution line for the active
// workspace. Service-role write (workspaces has no public UPDATE policy for
// arbitrary columns from the client) scoped to the active workspace id, so a
// user can only ever flip their OWN workspace's flag. The flag only has an
// effect on hobby-plan posts (the plan gate lives in lib/growth/attribution).
export async function setAttributionEnabledAction(enabled: boolean): Promise<ActionResult> {
  const ws = await getActiveWorkspaceOrRedirect();
  const svc = supabaseService();
  const { error } = await svc
    .from("workspaces")
    .update({ attribution_enabled: enabled })
    .eq("id", ws.id);
  if (error) return { error: error.message };
  revalidatePath("/settings/referrals");
  return { error: null };
}
