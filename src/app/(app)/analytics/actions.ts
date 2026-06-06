"use server";

import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";
import { getActiveWorkspaceOrRedirect, getAuthedUserOrRedirect } from "@/lib/workspace";
import { recordOutcomeInputSchema } from "@/lib/analytics/outcome-schema";

// Outcome Loop MVP (Bet 1) — /analytics server actions.
//
// recordOutcomeAction: attach a self-reported BUSINESS outcome (lead / sale /
// signup / booking / other) to a live post, optionally with a dollar amount and
// a note. Validated with zod at the boundary; workspace-scoped exactly like the
// sibling competitor / queue actions:
//   1. resolve the active workspace (redirects if none),
//   2. parse + coerce the form (rejects bad input with a friendly message),
//   3. confirm the target post belongs to THIS workspace before inserting
//      (defense-in-depth — RLS already gates the insert, but we never want to
//      attribute an outcome to a post the caller can't see),
//   4. insert through the AUTHED client so RLS double-checks membership.
//
// SCOPE: self-report only. No UTM / pixel — deferred phase 2.

export type RecordOutcomeState = { error: string | null; success: string | null };

export async function recordOutcomeAction(
  _prev: RecordOutcomeState,
  formData: FormData,
): Promise<RecordOutcomeState> {
  const ws = await getActiveWorkspaceOrRedirect();
  const user = await getAuthedUserOrRedirect();

  const parsed = recordOutcomeInputSchema.safeParse({
    post_id: formData.get("post_id") ?? "",
    outcome_type: formData.get("outcome_type") ?? "",
    amount_dollars: formData.get("amount_dollars") ?? "",
    note: formData.get("note") ?? undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the form.", success: null };
  }
  const input = parsed.data;

  const supabase = await supabaseServer();

  // Confirm the post is in THIS workspace before attributing anything to it.
  const { data: post, error: postErr } = await supabase
    .from("posts")
    .select("id")
    .eq("id", input.post_id)
    .eq("workspace_id", ws.id)
    .maybeSingle();
  if (postErr) {
    return { error: postErr.message, success: null };
  }
  if (!post) {
    return { error: "That post isn't in this workspace.", success: null };
  }

  const { error } = await supabase.from("post_outcomes").insert({
    workspace_id: ws.id,
    post_id: input.post_id,
    outcome_type: input.outcome_type,
    value_cents: input.value_cents,
    note: input.note,
    created_by: user.id,
  });
  if (error) {
    return { error: error.message, success: null };
  }

  // The page recomputes the revenue-ranked themes on next render.
  revalidatePath("/analytics");
  return { error: null, success: "Outcome recorded." };
}
