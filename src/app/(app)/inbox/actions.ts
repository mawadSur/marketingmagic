"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { SNOOZE_DURATION_MS } from "@/lib/interactions/schema";

const uuid = z.string().uuid();

export interface InboxActionResult {
  error: string | null;
}

export async function snoozeInteractionAction(
  interactionId: string,
): Promise<InboxActionResult> {
  if (!uuid.safeParse(interactionId).success) {
    return { error: "Bad interaction id." };
  }
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();

  const snoozeUntil = new Date(Date.now() + SNOOZE_DURATION_MS).toISOString();
  const { error } = await supabase
    .from("interactions")
    .update({ status: "snoozed", snooze_until: snoozeUntil })
    .eq("id", interactionId)
    .eq("workspace_id", ws.id);
  if (error) return { error: error.message };
  revalidatePath("/inbox");
  return { error: null };
}

export async function dismissInteractionAction(
  interactionId: string,
): Promise<InboxActionResult> {
  if (!uuid.safeParse(interactionId).success) {
    return { error: "Bad interaction id." };
  }
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();
  const { error } = await supabase
    .from("interactions")
    .update({ status: "dismissed" })
    .eq("id", interactionId)
    .eq("workspace_id", ws.id);
  if (error) return { error: error.message };
  revalidatePath("/inbox");
  return { error: null };
}

// Marks an interaction as read. Used by the detail page when the user
// opens an unread row.
export async function markReadAction(
  interactionId: string,
): Promise<InboxActionResult> {
  if (!uuid.safeParse(interactionId).success) {
    return { error: "Bad interaction id." };
  }
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();
  const { error } = await supabase
    .from("interactions")
    .update({ status: "read" })
    .eq("id", interactionId)
    .eq("workspace_id", ws.id)
    .eq("status", "unread"); // only flip if currently unread
  if (error) return { error: error.message };
  revalidatePath("/inbox");
  return { error: null };
}
