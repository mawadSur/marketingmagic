"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { generatePlan } from "@/lib/plan/generate";
import { collectThemeSignals } from "@/lib/plan/signals";
import { loadRecentPatterns } from "@/lib/explain/playbook";
import { channelSpec, ENABLED_CHANNELS, type ChannelId } from "@/lib/channels/registry";
import { assertWithinPostQuota, QuotaExceededError } from "@/lib/billing/limits";
import { incrementPostsGenerated } from "@/lib/billing/usage";

export type GeneratePlanState = { error: string | null; planId: string | null };

const channelSelectionSchema = z.object({
  accountId: z.string().uuid(),
  postsPerWeek: z.number().int().min(1).max(28),
});

const formSchema = z.object({
  weeks: z.number().int().min(1).max(4),
  channels: z.array(channelSelectionSchema).min(1).max(8),
});

function parseFormData(formData: FormData): z.SafeParseReturnType<unknown, z.infer<typeof formSchema>> {
  const weeks = Number(formData.get("weeks") ?? "1");
  const channels: Array<{ accountId: string; postsPerWeek: number }> = [];

  // Form fields shape: include_<id> = "on" + posts_<id> = "<n>".
  // We iterate include_* keys and read the matching posts field.
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("include_")) continue;
    if (value !== "on") continue;
    const accountId = key.slice("include_".length);
    const ppw = Number(formData.get(`posts_${accountId}`) ?? "0");
    channels.push({ accountId, postsPerWeek: ppw });
  }

  return formSchema.safeParse({ weeks, channels });
}

export async function generatePlanAction(
  _prev: GeneratePlanState,
  formData: FormData,
): Promise<GeneratePlanState> {
  const ws = await getActiveWorkspaceOrRedirect();
  const parsed = parseFormData(formData);
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? "Pick at least one channel and a posts/week count.",
      planId: null,
    };
  }

  const supabase = await supabaseServer();

  // Load brief + all selected accounts in one trip; reject any that don't
  // belong to the workspace or aren't connected.
  const accountIds = parsed.data.channels.map((c) => c.accountId);
  const [briefRes, accountsRes] = await Promise.all([
    supabase.from("brand_briefs").select("*").eq("workspace_id", ws.id).maybeSingle(),
    supabase
      .from("social_accounts_safe")
      .select("id, channel, handle, trust_mode")
      .eq("workspace_id", ws.id)
      .eq("status", "connected")
      .in("id", accountIds),
  ]);
  if (!briefRes.data) return { error: "Workspace has no brand brief.", planId: null };
  const accounts = accountsRes.data ?? [];
  if (accounts.length !== accountIds.length) {
    return { error: "One or more selected accounts not found.", planId: null };
  }

  // Build channelMix. Skip any account whose channel isn't enabled.
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const channelMix: Array<{ channel: ChannelId; handle: string; posts_per_week: number }> = [];
  for (const sel of parsed.data.channels) {
    const acct = accountById.get(sel.accountId);
    if (!acct) continue;
    if (!ENABLED_CHANNELS.includes(acct.channel as ChannelId)) continue;
    channelMix.push({
      channel: acct.channel as ChannelId,
      handle: acct.handle,
      posts_per_week: sel.postsPerWeek,
    });
  }
  if (channelMix.length === 0) {
    return { error: "No supported channels selected.", planId: null };
  }

  // Signals share across all channels for now — V2 keeps theme signals
  // channel-agnostic. Per-channel signal split is a future refinement.
  const [{ winners, losers, parent_plan_id }, savedPatterns] = await Promise.all([
    collectThemeSignals(ws.id),
    loadRecentPatterns(ws.id),
  ]);

  // Estimate posts BEFORE calling Claude so we don't burn tokens for a
  // workspace that's over quota. We charge for what we actually generated
  // below, so the estimate is an upper bound — the AI sometimes drops
  // posts for unsupported channels.
  const estimatedPosts = channelMix.reduce((sum, c) => sum + c.posts_per_week * parsed.data.weeks, 0);
  try {
    await assertWithinPostQuota(ws.id, estimatedPosts);
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      return { error: err.message, planId: null };
    }
    throw err;
  }

  let result;
  try {
    const startDate = new Date();
    result = await generatePlan({
      brief: briefRes.data,
      channelMix,
      weeks: parsed.data.weeks,
      startDate,
      winners,
      losers,
      savedPatterns,
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Generation failed.", planId: null };
  }

  // Persist with service role (RLS-bypass for atomic plan+posts insert).
  const svc = supabaseService();
  const startAt = new Date();
  const endAt = new Date(startAt.getTime() + parsed.data.weeks * 7 * 24 * 60 * 60 * 1000);

  const { data: planRow, error: planErr } = await svc
    .from("posting_plans")
    .insert({
      workspace_id: ws.id,
      name: result.plan.plan_name,
      start_at: startAt.toISOString(),
      end_at: endAt.toISOString(),
      status: "active",
      parent_plan_id,
      generation_prompt: result.plan.overview,
      generation_response: result.plan as unknown as import("@/lib/db/types").Json,
    })
    .select("id")
    .single();
  if (planErr || !planRow) {
    return { error: planErr?.message ?? "Failed to save plan.", planId: null };
  }

  // Resolve each generated post to a social_account_id by channel. If a post
  // names a channel we don't have an account for (Claude misbehaved), we
  // drop it from the batch and surface a soft error.
  const accountByChannel = new Map<string, typeof accounts[number]>();
  for (const a of accounts) accountByChannel.set(a.channel, a);

  const skipped: string[] = [];
  const postsPayload = result.plan.posts.flatMap((p) => {
    const acct = accountByChannel.get(p.channel);
    if (!acct) {
      skipped.push(p.channel);
      return [];
    }
    const trusted = acct.trust_mode === true;
    // Enforce per-channel max chars. If Claude exceeded, truncate rather
    // than reject — losing one line beats throwing the plan away.
    const max = channelSpec(acct.channel)?.maxChars ?? 280;
    const text = p.text.length > max ? p.text.slice(0, max - 1) + "…" : p.text;

    return [
      {
        workspace_id: ws.id,
        plan_id: planRow.id,
        social_account_id: acct.id,
        channel: acct.channel,
        text,
        theme: p.theme,
        scheduled_at: p.suggested_scheduled_at,
        status: (trusted ? "scheduled" : "pending_approval") as "scheduled" | "pending_approval",
        generation_metadata: {
          rationale: p.rationale,
          cache_read_input_tokens: result.usage.cache_read_input_tokens ?? 0,
          auto_scheduled: trusted,
          image_prompt: p.image_prompt ?? null,
        },
      },
    ];
  });

  if (postsPayload.length === 0) {
    await svc.from("posting_plans").delete().eq("id", planRow.id);
    return { error: "Claude generated only posts for channels you haven't connected.", planId: null };
  }

  const { error: postsErr } = await svc.from("posts").insert(postsPayload);
  if (postsErr) {
    await svc.from("posting_plans").delete().eq("id", planRow.id);
    return { error: postsErr.message, planId: null };
  }

  // Charge billing usage for the actual number of posts inserted (we may
  // have dropped some for unsupported channels). Best-effort — a counter
  // failure here shouldn't block the user from seeing their plan.
  try {
    await incrementPostsGenerated(ws.id, postsPayload.length);
  } catch (err) {
    console.warn("Failed to increment posts usage counter:", err);
  }

  revalidatePath("/plans");
  revalidatePath("/queue");
  if (skipped.length > 0) {
    // Best-effort: log it. We still want to redirect to the plan since most
    // posts landed; surfacing as a banner there is a future polish.
    console.warn("Plan generator dropped posts for unconnected channels:", skipped);
  }
  redirect(`/plans/${planRow.id}`);
}
