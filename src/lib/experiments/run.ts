// Phase 6B — Quick Experiment runner.
//
// Spawn an experiment from an existing post:
//   1. Generate N variants via generateVariants()
//   2. Pick N scheduling slots ≥48h apart, biased toward Smart Timing's
//      optimal windows when the channel has them
//   3. Insert experiments + post_variants + N posts in pending_approval
//      status (user reviews variants in the queue before they ship)
//
// All three table writes happen via the service role for atomicity —
// the user already passed RLS at the action-layer ownership check.

import { supabaseService } from "@/lib/supabase/service";
import type { Database } from "@/lib/db/types";
import { getOptimalWindows, nextOptimalSlotIso } from "@/lib/timing/analyze";
import {
  generateVariants,
  MAX_VARIANT_COUNT,
  MIN_VARIANT_COUNT,
  type GeneratedVariant,
} from "./generate";

type PostRow = Database["public"]["Tables"]["posts"]["Row"];
type BriefRow = Database["public"]["Tables"]["brand_briefs"]["Row"];

export interface RunExperimentInputs {
  workspaceId: string;
  parentPost: Pick<
    PostRow,
    "id" | "text" | "channel" | "theme" | "social_account_id" | "workspace_id"
  >;
  // Pulled in by the caller so this module stays DB-thin. Voice profile +
  // product description are passed straight to the variant generator.
  brief: Pick<BriefRow, "product_description" | "voice_profile"> | null;
  variantCount?: number;
}

export interface RunExperimentResult {
  experimentId: string;
  variants: Array<{
    variantId: string;
    postId: string;
    scheduledAt: string;
    hook: string;
  }>;
}

// Fallback offsets when Smart Timing returns no slots. Spec calls for
// +48h, +96h, +144h (i.e. 2/4/6 days from now); we extend out for higher
// variant counts in 48h steps.
const FALLBACK_OFFSETS_HOURS = [48, 96, 144, 192, 240]; // up to MAX_VARIANT_COUNT
const MIN_SPACING_HOURS = 48;
const HOUR_MS = 60 * 60 * 1000;

export async function runQuickExperiment(
  inputs: RunExperimentInputs,
): Promise<RunExperimentResult> {
  const variantCount = inputs.variantCount ?? 3;
  if (variantCount < MIN_VARIANT_COUNT || variantCount > MAX_VARIANT_COUNT) {
    throw new Error(
      `Variant count must be ${MIN_VARIANT_COUNT}-${MAX_VARIANT_COUNT} (got ${variantCount}).`,
    );
  }

  // Step 1 — generate variants. Failures bubble up to the action layer.
  const { variants } = await generateVariants(
    {
      text: inputs.parentPost.text,
      channel: inputs.parentPost.channel,
      theme: inputs.parentPost.theme,
      productDescription: inputs.brief?.product_description ?? null,
      voiceProfile:
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (inputs.brief?.voice_profile as any) ?? null,
    },
    variantCount,
  );

  // Step 2 — pick slots. Try Smart Timing first; fall back to fixed
  // offsets when the channel has no windows. We always enforce a 48h
  // minimum spacing between consecutive variants regardless of source.
  const slots = await pickSlots(
    inputs.workspaceId,
    inputs.parentPost.channel,
    variantCount,
  );

  // Step 3 — atomic insert of experiments + posts + post_variants.
  const svc = supabaseService();
  const { data: expRow, error: expErr } = await svc
    .from("experiments")
    .insert({
      workspace_id: inputs.workspaceId,
      parent_post_id: inputs.parentPost.id,
      variant_count: variantCount,
    })
    .select("id")
    .single();
  if (expErr || !expRow) {
    throw new Error(`Experiment insert failed: ${expErr?.message ?? "unknown"}`);
  }
  const experimentId = expRow.id;

  // Insert one post per variant. We mark them pending_approval so the
  // user reviews each in the queue before they ship — trust-mode is
  // explicitly bypassed for experiment variants (no auto-publish).
  const postPayload = variants.map((v, i) => ({
    workspace_id: inputs.workspaceId,
    social_account_id: inputs.parentPost.social_account_id,
    channel: inputs.parentPost.channel,
    text: v.text,
    theme: inputs.parentPost.theme,
    scheduled_at: slots[i],
    status: "pending_approval" as const,
    // Stash the hook + experiment ref in generation_metadata so the
    // queue UI can render "Experiment variant — hook: ..." inline.
    generation_metadata: {
      experiment_id: experimentId,
      parent_post_id: inputs.parentPost.id,
      variant_index: i,
      variant_count: variantCount,
      hook: v.hook,
      rationale: v.rationale,
    } as never,
  }));

  const { data: insertedPosts, error: postErr } = await svc
    .from("posts")
    .insert(postPayload)
    .select("id");
  if (postErr || !insertedPosts || insertedPosts.length !== variantCount) {
    // Roll back the experiment row so we don't leave a dangling parent.
    await svc.from("experiments").delete().eq("id", experimentId);
    throw new Error(`Variant posts insert failed: ${postErr?.message ?? "row count mismatch"}`);
  }

  const variantPayload = insertedPosts.map((p) => ({
    experiment_id: experimentId,
    parent_post_id: p.id,
    workspace_id: inputs.workspaceId,
    allocation_weight: 1.0,
  }));

  const { data: insertedVariants, error: varErr } = await svc
    .from("post_variants")
    .insert(variantPayload)
    .select("id, parent_post_id");
  if (varErr || !insertedVariants || insertedVariants.length !== variantCount) {
    // Best-effort rollback — both posts and the experiment.
    await svc
      .from("posts")
      .delete()
      .in("id", insertedPosts.map((p) => p.id));
    await svc.from("experiments").delete().eq("id", experimentId);
    throw new Error(`post_variants insert failed: ${varErr?.message ?? "row count mismatch"}`);
  }

  const variantsByPostId = new Map(insertedVariants.map((v) => [v.parent_post_id, v.id]));

  return {
    experimentId,
    variants: insertedPosts.map((p, i) => ({
      variantId: variantsByPostId.get(p.id) ?? "",
      postId: p.id,
      scheduledAt: slots[i],
      hook: variants[i]?.hook ?? "",
    })),
  };
}

async function pickSlots(
  workspaceId: string,
  channel: string,
  count: number,
): Promise<string[]> {
  const slots: string[] = [];
  const now = new Date();

  // Attempt Smart Timing first. If it throws (eg cold-start), we fall
  // through to the offset ladder below.
  let windows: Awaited<ReturnType<typeof getOptimalWindows>> | null = null;
  try {
    windows = await getOptimalWindows(workspaceId, channel);
  } catch {
    windows = null;
  }

  // Cursor advances past each picked slot to enforce MIN_SPACING_HOURS.
  let cursor = new Date(now.getTime() + MIN_SPACING_HOURS * HOUR_MS);

  for (let i = 0; i < count; i++) {
    let chosen: string | null = null;
    if (windows && windows.top.length > 0) {
      chosen = nextOptimalSlotIso(windows, { from: cursor, horizonDays: 21 });
    }
    if (!chosen) {
      const offset = FALLBACK_OFFSETS_HOURS[Math.min(i, FALLBACK_OFFSETS_HOURS.length - 1)];
      chosen = new Date(now.getTime() + offset * HOUR_MS).toISOString();
    }
    slots.push(chosen);
    // Push cursor MIN_SPACING_HOURS past the chosen slot so the next
    // pick lands ≥48h later.
    cursor = new Date(new Date(chosen).getTime() + MIN_SPACING_HOURS * HOUR_MS);
  }

  return slots;
}
