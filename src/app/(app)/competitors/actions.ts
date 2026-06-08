"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";
import { getActiveWorkspaceOrRedirect, getAuthedUserOrRedirect } from "@/lib/workspace";
import {
  watchHandleInputSchema,
  normalizeHandle,
  type WatchHandleInput,
} from "@/lib/competitors/schema";
import { isCompetitorWatchEnabled } from "@/lib/billing/feature-gates";
import type { Database, Json } from "@/lib/db/types";

// Phase 6.6 — /competitors server actions.
//
// Three actions:
//   • addWatchHandleAction      — insert a watch_handles row.
//   • removeWatchHandleAction   — delete a watch_handles row + its cached
//                                 competitor_posts (via ON DELETE CASCADE).
//   • useWinnerAsSourceAction   — pre-fills a `sources` row from a winner
//                                 then runs the source-anchored generator
//                                 to draft a NEUTRAL response into /queue.
//
// All three short-circuit when the workspace plan doesn't include
// Competitor Watch (Founder/Agency). The /competitors page also gates
// the UI, but actions re-check defensively.
//
// Anti-harassment: useWinnerAsSourceAction injects an explicit
// "respond to / build on the idea, not the author" retryNote into the
// planner and never frames the action as adversarial. The planner system
// prompt has its own refusal rule for takedown framings; this action
// passes only the winner's text + a constructive intent string.

export type AddWatchHandleState = { error: string | null; ok: boolean };

export async function addWatchHandleAction(
  _prev: AddWatchHandleState,
  formData: FormData,
): Promise<AddWatchHandleState> {
  const ws = await getActiveWorkspaceOrRedirect();
  if (!isCompetitorWatchEnabled(ws.plan)) {
    return { error: "Competitor Watch is available on the Creator tier.", ok: false };
  }
  const user = await getAuthedUserOrRedirect();

  const parsed = watchHandleInputSchema.safeParse({
    channel: formData.get("channel") ?? "",
    handle: formData.get("handle") ?? "",
    display_name: formData.get("display_name") ?? undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the form.", ok: false };
  }
  const input: WatchHandleInput = parsed.data;
  const normalized = normalizeHandle(input.channel, input.handle);
  if (!normalized) {
    return { error: "Handle is empty after normalising.", ok: false };
  }

  const supabase = await supabaseServer();
  const { error } = await supabase.from("watch_handles").insert({
    workspace_id: ws.id,
    channel: input.channel,
    handle: normalized,
    display_name: input.display_name ?? null,
    added_by: user.id,
  });
  if (error) {
    // Unique-violation = already watching. Surface a friendly message.
    if (error.code === "23505") {
      return { error: "You're already watching that handle.", ok: false };
    }
    return { error: error.message, ok: false };
  }

  revalidatePath("/competitors");
  redirect("/competitors");
}

export async function removeWatchHandleAction(formData: FormData): Promise<void> {
  const ws = await getActiveWorkspaceOrRedirect();
  if (!isCompetitorWatchEnabled(ws.plan)) return;
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const supabase = await supabaseServer();
  await supabase.from("watch_handles").delete().eq("id", id).eq("workspace_id", ws.id);

  revalidatePath("/competitors");
}

// Counter-content trigger.
//
// Flow: winner → sources row (kind='transcript', summary = "Response to ...")
//        → generateFromSource with a NEUTRAL retryNote
//        → first idea's posts dropped into pending_approval
//
// We mark the competitor row drafted_at so the UI grays out the button
// (preventing accidental double-drafts) without preventing intentional
// re-drafting from a different angle (the user can delete the source).
// Direct form action — returns Promise<void> so callers can bind it
// without useActionState. Failures redirect to /competitors with an
// optional ?error= query param the page surfaces.
export async function useWinnerAsSourceAction(formData: FormData): Promise<void> {
  const ws = await getActiveWorkspaceOrRedirect();
  if (!isCompetitorWatchEnabled(ws.plan)) {
    redirect("/competitors?error=tier_gated");
  }
  const user = await getAuthedUserOrRedirect();
  const competitorPostId = String(formData.get("competitor_post_id") ?? "");
  if (!competitorPostId) redirect("/competitors?error=missing_id");

  const supabase = await supabaseServer();

  // 1. Load the competitor row + the joined watch handle + brief.
  //    Two queries (rather than one with a relation join) so the JS-client
  //    types stay narrow — the join projection on competitor_posts widens
  //    selected columns to GenericStringError.
  const { data: row, error: rowErr } = await supabase
    .from("competitor_posts")
    .select("id, watch_handle_id, text, post_url, pattern_tags, pattern_reason, drafted_at")
    .eq("id", competitorPostId)
    .eq("workspace_id", ws.id)
    .single();
  if (rowErr || !row) redirect("/competitors?error=not_found");

  const { data: handleRow } = await supabase
    .from("watch_handles")
    .select("channel, handle")
    .eq("id", row.watch_handle_id)
    .single();
  const competitorChannel = handleRow?.channel ?? "x";

  const { data: brief } = await supabase
    .from("brand_briefs")
    .select("id")
    .eq("workspace_id", ws.id)
    .maybeSingle();
  if (!brief) redirect("/competitors?error=no_brief");

  // 2. Build a sources row anchored to the competitor's text. We use
  //    source_kind='transcript' because it's the closest existing kind
  //    for "a discrete chunk of someone else's text we want to respond
  //    to." Title is constructive — "Response to a post about X" — never
  //    framed as adversarial.
  const themes = Array.isArray(row.pattern_tags) ? row.pattern_tags : [];
  const summaryParts = [row.text];
  if (row.pattern_reason) summaryParts.push(`Possible reason it resonated: ${row.pattern_reason}`);
  summaryParts.push(
    "Goal: build on or respond to this idea constructively. Do not attack the author.",
  );

  const { data: sourceRow, error: sourceErr } = await supabase
    .from("sources")
    .insert({
      workspace_id: ws.id,
      source_kind: "transcript",
      source_url: row.post_url,
      title: `Response to a post on ${competitorChannel}`,
      extracted_summary: summaryParts.join("\n\n"),
      extracted_themes: themes as unknown as Json,
      extracted_quotes: [] as unknown as Json,
      extracted_facts: [] as unknown as Json,
      ingested_by: user.id,
    })
    .select("*")
    .single();
  if (sourceErr || !sourceRow) redirect("/competitors?error=seed_failed");

  // 3. Mark competitor row drafted_at so the UI dims the button.
  await supabase
    .from("competitor_posts")
    .update({ drafted_at: new Date().toISOString(), drafted_by: user.id })
    .eq("id", competitorPostId);

  // 4. Hand off to /sources/[id]. The user reviews the seed (text +
  //    pattern tags + reason) and explicitly triggers cluster generation
  //    from there — same flow as any other source. We intentionally do
  //    NOT auto-run generateFromSource here so the user has a chance to
  //    edit the seed if anything reads as adversarial. Planner prompt
  //    has its own refusal rule for takedown framings as a second line.

  revalidatePath("/competitors");
  revalidatePath("/sources");
  redirect(`/sources/${sourceRow.id}`);
}

// Server-side helper used by the page to load the workspace's active
// rows + recent winners.
export interface WatchHandleWithWinners {
  handle: Database["public"]["Tables"]["watch_handles"]["Row"];
  recentWinners: Database["public"]["Tables"]["competitor_posts"]["Row"][];
}

export async function loadCompetitorState(workspaceId: string): Promise<WatchHandleWithWinners[]> {
  const supabase = await supabaseServer();
  const { data: handles } = await supabase
    .from("watch_handles")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("added_at", { ascending: false });

  const handleRows = (handles ?? []) as Database["public"]["Tables"]["watch_handles"]["Row"][];
  if (handleRows.length === 0) return [];

  const handleIds = handleRows.map((h) => h.id);
  const { data: winners } = await supabase
    .from("competitor_posts")
    .select("*")
    .in("watch_handle_id", handleIds)
    .eq("is_winner", true)
    .order("posted_at", { ascending: false })
    .limit(50);

  const byHandle = new Map<string, Database["public"]["Tables"]["competitor_posts"]["Row"][]>();
  for (const w of winners ?? []) {
    const arr = byHandle.get(w.watch_handle_id) ?? [];
    arr.push(w);
    byHandle.set(w.watch_handle_id, arr);
  }
  return handleRows.map((h) => ({ handle: h, recentWinners: byHandle.get(h.id) ?? [] }));
}
