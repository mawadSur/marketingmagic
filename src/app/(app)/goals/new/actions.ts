"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { proposeStrategy } from "@/lib/goals/reverse-plan";
import { goalDraftSchema } from "@/lib/goals/schema";
import { ENABLED_CHANNELS, type ChannelId } from "@/lib/channels/registry";
import type { Json, VoiceProfile } from "@/lib/db/types";

// /goals/new server action.
//
// Pipeline: form submit → normalize → proposeStrategy() → persist
// content_goals row (status='draft', strategy=jsonb) → redirect to
// /goals/[id] for the preview/approval gate.
//
// We don't generate any posts here. That happens on /goals/[id] after
// the user clicks "Approve & generate plan". The split mirrors the
// /sources two-step flow: extraction (fast) is committed first, generation
// (slow + token-heavy) waits for a deliberate green-light.

export type ProposeStrategyState = { error: string | null; goalId: string | null };

// Form-input schema. Empty strings become undefined so the numeric/date
// fields can stay optional without preventing form submission.
const formSchema = z.object({
  goal_metric: z.string(),
  goal_text: z.string(),
  target_value: z.string().optional(),
  target_date: z.string().optional(),
});

export async function proposeStrategyAction(
  _prev: ProposeStrategyState,
  formData: FormData,
): Promise<ProposeStrategyState> {
  const ws = await getActiveWorkspaceOrRedirect();

  const rawForm = formSchema.safeParse({
    goal_metric: formData.get("goal_metric") ?? "",
    goal_text: formData.get("goal_text") ?? "",
    target_value: (formData.get("target_value") ?? "") as string,
    target_date: (formData.get("target_date") ?? "") as string,
  });
  if (!rawForm.success) {
    return { error: "Form input invalid.", goalId: null };
  }

  // Normalize: trim, coerce optional numeric, drop empty strings.
  const targetValueRaw = (rawForm.data.target_value ?? "").trim();
  const targetValue = targetValueRaw === "" ? undefined : Number(targetValueRaw);
  const targetDate = (rawForm.data.target_date ?? "").trim() || undefined;

  const draftParsed = goalDraftSchema.safeParse({
    goal_metric: rawForm.data.goal_metric,
    goal_text: rawForm.data.goal_text,
    target_value: targetValue !== undefined && !Number.isFinite(targetValue) ? undefined : targetValue,
    target_date: targetDate,
  });
  if (!draftParsed.success) {
    return {
      error: draftParsed.error.issues[0]?.message ?? "Check the form fields.",
      goalId: null,
    };
  }

  // Load brief + connected accounts. The reverse-planner reads brand
  // context + voice profile; the channel mix constrains the posting cadence
  // it proposes. No accounts → can't draft a coherent strategy.
  const supabase = await supabaseServer();
  const [briefRes, accountsRes] = await Promise.all([
    supabase.from("brand_briefs").select("*").eq("workspace_id", ws.id).maybeSingle(),
    supabase
      .from("social_accounts_safe")
      .select("id, channel, handle")
      .eq("workspace_id", ws.id)
      .eq("status", "connected"),
  ]);
  if (!briefRes.data) {
    return { error: "Workspace has no brand brief.", goalId: null };
  }
  const accounts = (accountsRes.data ?? []).filter((a) =>
    ENABLED_CHANNELS.includes(a.channel as ChannelId),
  );
  if (accounts.length === 0) {
    return {
      error: "Connect at least one channel before setting a goal.",
      goalId: null,
    };
  }

  const channelMix = accounts.map((a) => ({
    channel: a.channel as ChannelId,
    handle: a.handle,
  }));

  // Propose strategy. Failures (Claude unavailable, validation) surface to
  // the form rather than persisting a half-baked row.
  let propose;
  try {
    propose = await proposeStrategy({
      goal: draftParsed.data,
      channelMix,
      voiceProfile: (briefRes.data.voice_profile as VoiceProfile | null) ?? null,
      productDescription: briefRes.data.product_description,
      targetAudience: briefRes.data.target_audience,
    });
  } catch (err) {
    // After the SDK exhausts its retries (maxRetries on the goal client), a
    // persistent 429 still surfaces here. Translate the raw rate_limit_error
    // JSON into a calm, actionable message instead of dumping the API payload.
    const msg = err instanceof Error ? err.message : "";
    const isRateLimit =
      (err as { status?: number })?.status === 429 ||
      /rate.?limit|429/i.test(msg);
    return {
      error: isRateLimit
        ? "We're generating a lot right now and hit Claude's per-minute limit. Wait about a minute and try again — your inputs are saved."
        : msg || "Could not propose a strategy.",
      goalId: null,
    };
  }

  // Persist as a draft. We store BOTH branches of the realism gate the
  // same way: the JSONB column always holds the same shape the preview
  // page expects to read back (`ProposeStrategyResult`).
  const insertPayload = {
    workspace_id: ws.id,
    goal_text: draftParsed.data.goal_text,
    goal_metric: draftParsed.data.goal_metric,
    target_value: draftParsed.data.target_value ?? null,
    target_date: draftParsed.data.target_date ?? null,
    status: "draft" as const,
    strategy: propose.result as unknown as Json,
  };
  const { data: inserted, error: insertErr } = await supabase
    .from("content_goals")
    .insert(insertPayload)
    .select("id")
    .single();
  if (insertErr || !inserted) {
    return {
      error: insertErr?.message ?? "Failed to save the goal.",
      goalId: null,
    };
  }

  revalidatePath("/goals");
  redirect(`/goals/${inserted.id}`);
}
