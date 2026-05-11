"use server";

import crypto from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";

type ActionResult = { error: string | null };

const createSchema = z.object({
  event_type: z.string().trim().min(1).max(80),
  template: z.string().trim().min(1).max(2000),
  channels: z
    .string()
    .trim()
    .min(1)
    .transform((v) =>
      v
        .split(",")
        .map((c) => c.trim().toLowerCase())
        .filter(Boolean),
    )
    .refine(
      (arr) =>
        arr.every((c) =>
          ["x", "instagram", "facebook", "threads", "bluesky", "linkedin"].includes(c),
        ),
      { message: "Unsupported channel." },
    ),
  theme: z.string().trim().min(1).max(60).optional().or(z.literal("").transform(() => undefined)),
});

export async function createEventRuleAction(formData: FormData): Promise<ActionResult> {
  const ws = await getActiveWorkspaceOrRedirect();
  const parsed = createSchema.safeParse({
    event_type: formData.get("event_type"),
    template: formData.get("template"),
    channels: formData.get("channels"),
    theme: formData.get("theme") ?? undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const supabase = await supabaseServer();
  const { error } = await supabase.from("event_rules").insert({
    workspace_id: ws.id,
    event_type: parsed.data.event_type,
    template: parsed.data.template,
    channels: parsed.data.channels,
    theme: parsed.data.theme ?? null,
  });
  if (error) return { error: error.message };

  revalidatePath("/settings/events");
  return { error: null };
}

export async function toggleEventRuleAction(id: string, enabled: boolean): Promise<ActionResult> {
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();
  const { error } = await supabase
    .from("event_rules")
    .update({ enabled })
    .eq("id", id)
    .eq("workspace_id", ws.id);
  if (error) return { error: error.message };
  revalidatePath("/settings/events");
  return { error: null };
}

export async function deleteEventRuleAction(id: string): Promise<ActionResult> {
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();
  const { error } = await supabase.from("event_rules").delete().eq("id", id).eq("workspace_id", ws.id);
  if (error) return { error: error.message };
  revalidatePath("/settings/events");
  return { error: null };
}

export async function rotateWebhookSecretAction(): Promise<{ secret: string | null; error: string | null }> {
  const ws = await getActiveWorkspaceOrRedirect();
  const svc = supabaseService();
  const next = crypto.randomBytes(32).toString("hex");
  const { error } = await svc.from("workspaces").update({ webhook_secret: next }).eq("id", ws.id);
  if (error) return { secret: null, error: error.message };
  revalidatePath("/settings/events");
  return { secret: next, error: null };
}
