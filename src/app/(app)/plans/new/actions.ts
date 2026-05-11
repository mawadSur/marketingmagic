"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { generatePlan } from "@/lib/plan/generate";
import { collectThemeSignals } from "@/lib/plan/signals";

export type GeneratePlanState = { error: string | null; planId: string | null };

const schema = z.object({
  x_account_id: z.string().uuid(),
  weeks: z.coerce.number().int().min(1).max(4),
  posts_per_week: z.coerce.number().int().min(1).max(28),
});

export async function generatePlanAction(
  _prev: GeneratePlanState,
  formData: FormData,
): Promise<GeneratePlanState> {
  const ws = await getActiveWorkspaceOrRedirect();
  const parsed = schema.safeParse({
    x_account_id: formData.get("x_account_id"),
    weeks: formData.get("weeks"),
    posts_per_week: formData.get("posts_per_week"),
  });
  if (!parsed.success) return { error: "Invalid input.", planId: null };

  const supabase = await supabaseServer();
  const [briefRes, accountRes] = await Promise.all([
    supabase.from("brand_briefs").select("*").eq("workspace_id", ws.id).maybeSingle(),
    supabase
      .from("social_accounts_safe")
      .select("*")
      .eq("id", parsed.data.x_account_id)
      .maybeSingle(),
  ]);
  if (!briefRes.data) return { error: "Workspace has no brand brief.", planId: null };
  if (!accountRes.data || accountRes.data.channel !== "x") {
    return { error: "X account not found.", planId: null };
  }

  // V1-16: pull theme signals from prior plans (best-effort; empty for first plan).
  const { winners, losers, parent_plan_id } = await collectThemeSignals(ws.id);

  let result;
  try {
    const startDate = new Date();
    result = await generatePlan({
      brief: briefRes.data,
      channelMix: [
        {
          channel: "x",
          handle: accountRes.data.handle,
          posts_per_week: parsed.data.posts_per_week,
        },
      ],
      weeks: parsed.data.weeks,
      startDate,
      winners,
      losers,
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

  const trusted = accountRes.data.trust_mode === true;
  const postsPayload = result.plan.posts.map((p) => ({
    workspace_id: ws.id,
    plan_id: planRow.id,
    social_account_id: parsed.data.x_account_id,
    channel: "x" as const,
    text: p.text,
    theme: p.theme,
    scheduled_at: p.suggested_scheduled_at,
    status: (trusted ? "scheduled" : "pending_approval") as "scheduled" | "pending_approval",
    generation_metadata: {
      rationale: p.rationale,
      cache_read_input_tokens: result.usage.cache_read_input_tokens ?? 0,
      auto_scheduled: trusted,
    },
  }));

  const { error: postsErr } = await svc.from("posts").insert(postsPayload);
  if (postsErr) {
    // Best-effort cleanup so we don't strand an empty plan.
    await svc.from("posting_plans").delete().eq("id", planRow.id);
    return { error: postsErr.message, planId: null };
  }

  revalidatePath("/plans");
  revalidatePath("/queue");
  redirect(`/plans/${planRow.id}`);
}
