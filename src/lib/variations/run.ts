// Hook×body variation runner + lineage persistence
// (Hormozi organic-first slices #3 + #4).
//
// runVariationGeneration(source) takes ONE source post, generates a hook×body
// matrix (default 10×3=30), and inserts the variations as pending_approval
// draft posts — each stamped with:
//   • parent_post_id     = the source post id          (migration 060)
//   • variation_group_id = one uuid for the whole batch (migration 060)
// so the queue can group the batch and the drafts trace back to their source.
//
// Mirrors src/lib/experiments/run.ts: generate → insert N posts via the service
// role (the caller already passed RLS at the action-layer ownership check),
// roll back on a row-count mismatch. The difference: lineage lives on the posts
// rows themselves (the two new columns), not in a separate experiments table.

import { supabaseService } from "@/lib/supabase/service";
import type { Database, Json } from "@/lib/db/types";
import { maxCharsFor } from "@/lib/channels/registry";
import {
  generateVariationMatrix,
  type VariationMatrixOptions,
} from "@/lib/variations/generate";

type PostRow = Database["public"]["Tables"]["posts"]["Row"];
type BriefRow = Database["public"]["Tables"]["brand_briefs"]["Row"];

export interface RunVariationInputs {
  workspaceId: string;
  // The source post we're spinning into a matrix. Only the fields the runner
  // needs — the variations inherit its channel + account + theme.
  sourcePost: Pick<
    PostRow,
    "id" | "text" | "channel" | "theme" | "social_account_id" | "workspace_id"
  >;
  // Pulled in by the caller so this module stays DB-thin (same as the
  // experiment runner). Optional — the source text is the voice anchor without it.
  brief: Pick<BriefRow, "product_description" | "voice_profile"> | null;
  // Matrix shape. Defaults to 10×3=30 inside the generator.
  matrix?: VariationMatrixOptions;
}

export interface RunVariationResult {
  variationGroupId: string;
  created: number;
  hookCount: number;
  bodyCount: number;
  usage: { input_tokens: number; output_tokens: number };
}

export async function runVariationGeneration(
  inputs: RunVariationInputs,
): Promise<RunVariationResult> {
  // Validate at the boundary — the source must carry the message we're varying.
  if (!inputs.sourcePost.text || inputs.sourcePost.text.trim().length === 0) {
    throw new Error("Source post has no text to vary.");
  }

  // Step 1 — generate the matrix. Failures bubble up to the action layer.
  const { variations, hookCount, bodyCount, matrix, usage } = await generateVariationMatrix(
    {
      text: inputs.sourcePost.text,
      theme: inputs.sourcePost.theme,
      productDescription: inputs.brief?.product_description ?? null,
      voiceProfile:
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (inputs.brief?.voice_profile as any) ?? null,
    },
    inputs.matrix,
  );

  // Step 2 — mint ONE batch tag for the whole generation, then fan out the
  // variations into draft posts that all share it and point at the source.
  const variationGroupId = crypto.randomUUID();
  const maxChars = maxCharsFor(inputs.sourcePost.channel);

  const postPayload = variations.map((v) => {
    // Truncate rather than drop if a composed script overran the channel cap —
    // the row column also enforces it; losing the tail beats losing the draft.
    const text = v.full_text.length > maxChars ? v.full_text.slice(0, maxChars - 1) + "…" : v.full_text;
    return {
      workspace_id: inputs.workspaceId,
      social_account_id: inputs.sourcePost.social_account_id,
      channel: inputs.sourcePost.channel,
      text,
      theme: inputs.sourcePost.theme,
      // Variations land UNSCHEDULED in pending_approval — the creator reviews +
      // schedules each in the queue (same as atomized drafts). Trust-mode
      // auto-publish is bypassed: a 30-draft burst is exploratory, eyeball-first.
      status: "pending_approval" as const,
      // Lineage (migration 060): trace every draft to its source + batch.
      parent_post_id: inputs.sourcePost.id,
      variation_group_id: variationGroupId,
      generation_metadata: {
        source: "variation",
        parent_post_id: inputs.sourcePost.id,
        variation_group_id: variationGroupId,
        hook_index: v.hook_index,
        body_index: v.body_index,
        hook_spoken: v.hook.spoken,
        hook_visual: v.hook.visual,
        cta_overlay: v.body.cta_overlay,
      } as unknown as Json,
    };
  });

  if (postPayload.length === 0) {
    // assembleVariations only returns empty if the matrix was empty, which the
    // schema's minItems forbids — but guard anyway so we never insert nothing.
    throw new Error("Variation generation produced no drafts.");
  }

  const svc = supabaseService();
  const { data: inserted, error } = await svc
    .from("posts")
    .insert(postPayload)
    .select("id");
  if (error || !inserted || inserted.length !== postPayload.length) {
    // Best-effort rollback so a partial insert doesn't strand orphan drafts.
    if (inserted && inserted.length > 0) {
      await svc.from("posts").delete().in("id", inserted.map((p) => p.id));
    }
    throw new Error(`Variation drafts insert failed: ${error?.message ?? "row count mismatch"}`);
  }

  // Stash the overview on the batch is not needed (no parent row); the per-row
  // generation_metadata carries the trace. `matrix.overview` is returned to the
  // caller so the UI can show "here's how we reframed it" if it wants.
  void matrix;

  return {
    variationGroupId,
    created: inserted.length,
    hookCount,
    bodyCount,
    usage,
  };
}
