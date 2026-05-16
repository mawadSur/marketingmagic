// Phase 4.5 — Replies-as-sources integration.
//
// Converts a high-signal inbound interaction (typically a thoughtful
// reply or a long-form LinkedIn comment) into a `sources` row of
// kind='transcript'. From there it's mineable for content via the
// existing Phase 2.5 pipeline.
//
// Surfaced from /inbox/[id] as a "Use as source →" action. The user
// clicks; we insert a sources row with the interaction body as the
// transcript text and a short title derived from the author handle
// plus a 60-char body slice.
//
// We do NOT call extractFromSource here — the inbox-to-source flow is
// a one-click "stash it" rather than a "run extraction now" path. The
// user can navigate to /sources/[id] and trigger extraction from there
// (which already exists as a server action).

import { supabaseServer } from "@/lib/supabase/server";
import { getActiveWorkspaceOrRedirect, getAuthedUserOrRedirect } from "@/lib/workspace";

export interface FromInteractionResult {
  sourceId: string | null;
  error: string | null;
}

export async function interactionToSource(
  interactionId: string,
): Promise<FromInteractionResult> {
  const ws = await getActiveWorkspaceOrRedirect();
  const user = await getAuthedUserOrRedirect();
  const supabase = await supabaseServer();

  const { data: interaction, error: loadErr } = await supabase
    .from("interactions")
    .select(
      "id, workspace_id, channel, author_handle, author_display_name, body, received_at",
    )
    .eq("id", interactionId)
    .eq("workspace_id", ws.id)
    .maybeSingle();
  if (loadErr || !interaction) {
    return { sourceId: null, error: loadErr?.message ?? "Interaction not found." };
  }

  // Body should be substantive enough to mine. Replies under 50 chars
  // ("Thanks!", "Same", etc.) aren't worth a sources row — return a
  // friendly error rather than inserting noise.
  if (interaction.body.trim().length < 50) {
    return {
      sourceId: null,
      error: "Reply is too short to be a useful source. (≥50 chars required.)",
    };
  }

  // Build a short, distinctive title: "@handle on <channel>: <first 60 chars>".
  const handle = interaction.author_display_name?.trim()
    || interaction.author_handle
    || "unknown";
  const titleHead = `${handle} on ${interaction.channel}`;
  const bodyTail = interaction.body.trim().slice(0, 80);
  const title = `${titleHead}: ${bodyTail}`.slice(0, 280);

  const { data: source, error: insErr } = await supabase
    .from("sources")
    .insert({
      workspace_id: ws.id,
      source_kind: "transcript",
      title,
      source_url: null,
      file_path: null,
      // The body is the entire "transcript". A follow-up extraction
      // pass will populate extracted_summary / quotes / themes / facts.
      extracted_summary: interaction.body.slice(0, 2000),
      extracted_quotes: [],
      extracted_themes: [],
      extracted_facts: [],
      ingested_by: user.id,
    })
    .select("id")
    .single();
  if (insErr || !source) {
    return { sourceId: null, error: insErr?.message ?? "Failed to create source." };
  }

  return { sourceId: source.id, error: null };
}
