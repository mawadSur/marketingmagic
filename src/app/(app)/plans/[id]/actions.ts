"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { explainerReasonKindSchema } from "@/lib/explain/schema";
import type { Json } from "@/lib/db/types";

const savePatternSchema = z.object({
  postId: z.string().uuid(),
  patternKind: explainerReasonKindSchema,
  summary: z.string().min(10).max(160),
  // Free-form structured fields the card already showed the user
  // (theme name, hour, etc.) — kept verbatim so plan-time prompts can
  // reference the same facts.
  data: z.record(z.string(), z.unknown()).optional(),
});

export interface SavePatternState {
  ok: boolean;
  error: string | null;
}

// Server action invoked from the WhyThisWinsCard "Save pattern" button.
// Validates ownership of the post (RLS-via-anon-client read), then inserts
// with service role so we don't have to thread the user JWT through
// playbook_patterns' insert policy.
export async function savePatternAction(
  _prev: SavePatternState,
  formData: FormData,
): Promise<SavePatternState> {
  const ws = await getActiveWorkspaceOrRedirect();

  const parsed = savePatternSchema.safeParse({
    postId: formData.get("postId"),
    patternKind: formData.get("patternKind"),
    summary: formData.get("summary"),
    data: formData.get("data") ? JSON.parse(String(formData.get("data"))) : undefined,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  // Ownership check via RLS — anon client. Confirms the post belongs to the
  // user's active workspace before we let the service-role write through.
  const supabase = await supabaseServer();
  const { data: post, error: postErr } = await supabase
    .from("posts")
    .select("id, workspace_id")
    .eq("id", parsed.data.postId)
    .eq("workspace_id", ws.id)
    .maybeSingle();
  if (postErr || !post) {
    return { ok: false, error: "Post not found in this workspace." };
  }

  const { data: { user } } = await supabase.auth.getUser();

  const svc = supabaseService();
  const { error: insErr } = await svc.from("playbook_patterns").insert({
    workspace_id: ws.id,
    source_post_id: post.id,
    pattern_kind: parsed.data.patternKind,
    pattern_data: (parsed.data.data ?? {}) as Json,
    summary: parsed.data.summary,
    saved_by: user?.id ?? null,
  });
  if (insErr) {
    return { ok: false, error: insErr.message };
  }

  // The card sits on both /dashboard and /plans/[id]; revalidate both so
  // the next render reflects the saved state.
  revalidatePath("/dashboard");
  revalidatePath("/plans/[id]", "page");

  return { ok: true, error: null };
}
