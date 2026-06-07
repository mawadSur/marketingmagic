"use server";

import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { parseOptInCheckbox, type AudioRetentionState } from "./audio-retention-parse";

// Phase 2.6 — audio_retention_opt_in toggle.
//
// Single-checkbox form to opt in/out of keeping raw voice-memo audio for 30
// days (migration 050). Default false = the raw audio is deleted right after
// Whisper transcription (the /record action simply never uploads it); true =
// retained in the private founder-audio bucket for 30 days. The toggle UI
// lives in ./audio-retention-section.tsx.
//
// Kept in its own file (not brief/actions.ts) so the brief action file stays
// under the 500-line ceiling — mirrors theme-snooze-actions.ts. The pure
// helpers live in ./audio-retention-parse.ts because a "use server" module may
// only export async Server Actions (a sync export fails the production build).

export type { AudioRetentionState };

export async function updateAudioRetentionAction(
  _prev: AudioRetentionState,
  formData: FormData,
): Promise<AudioRetentionState> {
  const ws = await getActiveWorkspaceOrRedirect();
  const optIn = parseOptInCheckbox(formData.get("opt_in"));

  const supabase = await supabaseServer();
  // Require an existing brief row. We don't auto-create one — audio retention
  // without a brief is meaningless (the voice-memo flow itself requires a
  // brief), and the brief form sits right below this control.
  const { data: existing } = await supabase
    .from("brand_briefs")
    .select("workspace_id")
    .eq("workspace_id", ws.id)
    .maybeSingle();
  if (!existing) {
    return {
      error: "Fill in your brand brief below before configuring audio retention.",
      message: null,
    };
  }

  const { error } = await supabase
    .from("brand_briefs")
    .update({ audio_retention_opt_in: optIn })
    .eq("workspace_id", ws.id);
  if (error) return { error: error.message, message: null };

  revalidatePath("/settings/brief");
  revalidatePath("/record");
  return {
    error: null,
    message: optIn
      ? "Got it — voice-memo audio will be kept for 30 days."
      : "Got it — voice-memo audio will be deleted right after transcription.",
  };
}
