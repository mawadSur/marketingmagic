"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { assertWithinPostQuota, QuotaExceededError } from "@/lib/billing/limits";
import { incrementPostsGenerated } from "@/lib/billing/usage";
import { runVariationGeneration } from "@/lib/variations/run";
import { DEFAULT_BODIES, DEFAULT_HOOKS } from "@/lib/variations/schema";

// "Generate 30 variations" server action (Hormozi organic-first slices #3+#4).
//
// Takes ONE source post and spins it into a hook×body matrix of draft posts —
// default 10 hooks × 3 bodies = 30 — each stamped with parent_post_id +
// variation_group_id (migration 060) so the batch traces back to its source.
//
// Mirrors runQuickExperimentAction: ownership check at the action boundary,
// brief pulled for voice context, quota enforced BEFORE the Claude call so we
// never burn tokens for an over-quota workspace, charge for what actually
// inserts, revalidate /queue. Distinct from experiments (a few alt hooks of an
// existing post) — this is the full 30-draft "turn your best clip into 30 you
// can film" wedge.

const uuid = z.string().uuid();

export type GenerateVariationsResult = {
  error: string | null;
  created: number | null;
  variationGroupId: string | null;
};

export async function generateVariationsAction(
  postId: string,
): Promise<GenerateVariationsResult> {
  if (!uuid.safeParse(postId).success) {
    return { error: "Bad post id.", created: null, variationGroupId: null };
  }

  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();

  // Ownership check at the boundary — RLS-scoped read of the source post.
  const { data: post, error: postErr } = await supabase
    .from("posts")
    .select("id, text, channel, theme, social_account_id, workspace_id")
    .eq("id", postId)
    .eq("workspace_id", ws.id)
    .maybeSingle();
  if (postErr || !post) {
    return { error: postErr?.message ?? "Post not found.", created: null, variationGroupId: null };
  }
  if (!post.text || post.text.trim().length === 0) {
    return { error: "This post has no text to vary.", created: null, variationGroupId: null };
  }

  // Quota check BEFORE the Claude call — estimate the full matrix as the upper
  // bound; we charge for what actually inserts below.
  const estimated = DEFAULT_HOOKS * DEFAULT_BODIES;
  try {
    await assertWithinPostQuota(ws.id, estimated);
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      return { error: err.message, created: null, variationGroupId: null };
    }
    throw err;
  }

  // Pull the brief for voice context (best-effort — generation still works
  // without it, the source text is the voice anchor).
  const svc = supabaseService();
  const { data: brief } = await svc
    .from("brand_briefs")
    .select("product_description, voice_profile")
    .eq("workspace_id", ws.id)
    .maybeSingle();

  let result;
  try {
    result = await runVariationGeneration({
      workspaceId: ws.id,
      sourcePost: post,
      brief: brief
        ? {
            product_description: brief.product_description,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            voice_profile: brief.voice_profile as any,
          }
        : null,
    });
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Variation generation failed.",
      created: null,
      variationGroupId: null,
    };
  }

  // Charge for the actual number of drafts inserted. Best-effort — a counter
  // failure shouldn't hide the drafts from the user.
  try {
    await incrementPostsGenerated(ws.id, result.created);
  } catch (err) {
    console.warn("Failed to increment posts usage counter:", err);
  }

  revalidatePath("/queue");
  return { error: null, created: result.created, variationGroupId: result.variationGroupId };
}
