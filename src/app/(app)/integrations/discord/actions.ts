"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { sendMessage, DiscordApiError } from "@/lib/integrations/discord";
import { buildDigestMessage } from "@/lib/integrations/embeds";
import { siteUrl } from "@/lib/env";
import type { DiscordEventFilters } from "@/lib/db/types";

// Server actions for /integrations/discord. All actions require the user
// be authed AND a workspace member — RLS handles the workspace check via
// the user-scoped Supabase client, then we switch to the service client
// only for the final write so we get full visibility into errors.

// ─────────────────────────────────────────────────────────────
// updateChannel — pick the destination channel
// ─────────────────────────────────────────────────────────────

export async function updateChannelAction(formData: FormData): Promise<void> {
  const integrationId = String(formData.get("integration_id") ?? "");
  const channelId = String(formData.get("target_channel_id") ?? "").trim();
  if (!integrationId || !channelId) {
    redirect("/integrations/discord?error=missing_fields");
  }
  if (!/^\d{6,32}$/.test(channelId)) {
    redirect("/integrations/discord?error=bad_channel_id");
  }

  const ws = await getActiveWorkspaceOrRedirect();
  const sb = await supabaseServer();
  // RLS-guard: confirm the integration belongs to the active workspace.
  const { data: row } = await sb
    .from("integrations")
    .select("id")
    .eq("id", integrationId)
    .eq("workspace_id", ws.id)
    .maybeSingle();
  if (!row) {
    redirect("/integrations/discord?error=not_found");
  }

  const svc = supabaseService();
  const { error } = await svc
    .from("integrations")
    .update({ target_channel_id: channelId })
    .eq("id", integrationId);
  if (error) {
    redirect(`/integrations/discord?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/integrations/discord");
  redirect("/integrations/discord?saved=channel");
}

// ─────────────────────────────────────────────────────────────
// updateFilters — toggle digest / realtime / alerts_only
// ─────────────────────────────────────────────────────────────

export async function updateFiltersAction(formData: FormData): Promise<void> {
  const integrationId = String(formData.get("integration_id") ?? "");
  if (!integrationId) {
    redirect("/integrations/discord?error=missing_fields");
  }

  const filters: DiscordEventFilters = {
    digest: formData.get("digest") === "on",
    realtime: formData.get("realtime") === "on",
    alerts_only: formData.get("alerts_only") === "on",
  };

  const ws = await getActiveWorkspaceOrRedirect();
  const sb = await supabaseServer();
  const { data: row } = await sb
    .from("integrations")
    .select("id")
    .eq("id", integrationId)
    .eq("workspace_id", ws.id)
    .maybeSingle();
  if (!row) {
    redirect("/integrations/discord?error=not_found");
  }

  const svc = supabaseService();
  const { error } = await svc
    .from("integrations")
    .update({ event_filters: filters })
    .eq("id", integrationId);
  if (error) {
    redirect(`/integrations/discord?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/integrations/discord");
  redirect("/integrations/discord?saved=filters");
}

// ─────────────────────────────────────────────────────────────
// sendTestMessage — fire a minimal embed to confirm wiring
// ─────────────────────────────────────────────────────────────

export async function sendTestMessageAction(formData: FormData): Promise<void> {
  const integrationId = String(formData.get("integration_id") ?? "");
  if (!integrationId) {
    redirect("/integrations/discord?error=missing_fields");
  }

  const ws = await getActiveWorkspaceOrRedirect();
  const sb = await supabaseServer();
  const { data: row } = await sb
    .from("integrations")
    .select("id, target_channel_id")
    .eq("id", integrationId)
    .eq("workspace_id", ws.id)
    .maybeSingle();
  if (!row || row.target_channel_id.startsWith("__pending__:")) {
    redirect("/integrations/discord?error=channel_not_set");
  }

  // Send a digest-shaped message with zero pending posts so we exercise
  // the same code path the cron will use later.
  const payload = buildDigestMessage({
    workspaceName: ws.name,
    posts: [],
    totalPending: 0,
    queueUrl: `${siteUrl()}/queue`,
  });

  // Override the title so the operator sees "Test message" rather than
  // "0 posts awaiting approval" which would be confusing.
  if (payload.embeds?.[0]) {
    payload.embeds[0].title = "Test message from marketingmagic";
    payload.embeds[0].description =
      "If you can read this, the integration is wired correctly.";
  }

  try {
    await sendMessage(row.target_channel_id, payload);
  } catch (err) {
    const msg =
      err instanceof DiscordApiError
        ? `${err.message}${err.bodyExcerpt ? ` — ${err.bodyExcerpt}` : ""}`
        : err instanceof Error
          ? err.message
          : "unknown_error";
    redirect(`/integrations/discord?error=${encodeURIComponent(msg)}`);
  }

  redirect("/integrations/discord?saved=test_sent");
}

// ─────────────────────────────────────────────────────────────
// removeIntegration — wipe the row
// ─────────────────────────────────────────────────────────────

export async function removeIntegrationAction(formData: FormData): Promise<void> {
  const integrationId = String(formData.get("integration_id") ?? "");
  if (!integrationId) {
    redirect("/integrations/discord?error=missing_fields");
  }

  const ws = await getActiveWorkspaceOrRedirect();
  const sb = await supabaseServer();
  const { data: row } = await sb
    .from("integrations")
    .select("id")
    .eq("id", integrationId)
    .eq("workspace_id", ws.id)
    .maybeSingle();
  if (!row) {
    redirect("/integrations/discord?error=not_found");
  }

  const svc = supabaseService();
  const { error } = await svc.from("integrations").delete().eq("id", integrationId);
  if (error) {
    redirect(`/integrations/discord?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/integrations/discord");
  redirect("/integrations/discord?saved=removed");
}
