"use server";

import { randomUUID } from "node:crypto";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseService } from "@/lib/supabase/service";
import { tierFor } from "@/lib/billing/tiers";
import { resolvePlanForWorkspace } from "@/lib/billing/entitlements";
import {
  transcribeAudioRich,
  TranscriptionUnavailableError,
  TranscriptionError,
  type JargonHint,
} from "@/lib/sources/transcribe";

// Hard ceiling on the raw audio blob we'll accept from the client. Groq's
// Whisper endpoint accepts up to 25 MB; we cap at 20 MB to leave headroom
// for the multipart framing and to avoid a "transcoded but rejected"
// failure mode. Mobile browsers default to webm/opus at ~32 kbps which
// gives ~80 minutes of audio inside the cap — plenty for a voice memo.
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

// Storage bucket for voice memos retained on user opt-in (brand_briefs
// .audio_retention_opt_in = true). Bucket is dashboard-created with a
// 30-day lifecycle and workspace-scoped path-prefix RLS — see migrations
// 015 + 050. When audio_retention_opt_in = false, we never touch Storage
// and the audio bytes are discarded after the Groq round-trip.
const AUDIO_BUCKET = "founder-audio";

export interface TranscribeRecordingResult {
  ok: boolean;
  // Populated on success.
  transcript?: string;
  // Phase 2.6/2: per-word jargon hints (low-confidence Whisper segments).
  // Empty array when Whisper returned no segment confidences (older
  // models, very short clips) — the client falls back to a plain
  // textarea with no marks in that case. See transcribe.ts for the
  // segment-vs-word caveat (Groq doesn't expose per-word probability).
  hints?: JargonHint[];
  // When the user has opt-in retention on, we return the Storage path so
  // the generate-from-voice-memo action can store it on the sources row.
  audioStoragePath?: string;
  // Single user-facing error message. We keep the messages friendly here
  // rather than surfacing raw provider/storage errors — the underlying
  // class name still flags the category for telemetry.
  error?: string;
}

// Server action invoked by the /record client after MediaRecorder stops.
// The client posts a FormData with one field — `audio` — containing the
// recorded Blob. We:
//   1. Re-verify the workspace is on the Founder tier (defense-in-depth
//      vs anyone hitting the action directly).
//   2. Read brand_briefs.audio_retention_opt_in.
//   3. If retention is on, upload to Storage before transcribing so the
//      blob is persisted before we touch Groq (so a Groq failure doesn't
//      cost the user the recording).
//   4. Transcribe via Groq Whisper.
//   5. Return the transcript (+ Storage path when applicable).
export async function transcribeRecordingAction(
  formData: FormData,
): Promise<TranscribeRecordingResult> {
  const ws = await getActiveWorkspaceOrRedirect();

  // Tier gate. /record page also gates on render, but the server action
  // re-checks because the page guard isn't a security boundary — the
  // action is. Uses the EFFECTIVE plan (resolver) so account-level sharing /
  // org inheritance count, not just this workspace's raw plan column.
  const svc = supabaseService();
  if (tierFor(await resolvePlanForWorkspace(ws.id)).id !== "founder") {
    return { ok: false, error: "Creator tier required to use voice capture." };
  }

  const file = formData.get("audio");
  if (!(file instanceof Blob)) {
    return { ok: false, error: "No audio attached." };
  }
  if (file.size === 0) {
    return { ok: false, error: "Empty recording — try again." };
  }
  if (file.size > MAX_AUDIO_BYTES) {
    return {
      ok: false,
      error: `Recording is too long (max ${Math.floor(MAX_AUDIO_BYTES / 1024 / 1024)} MB).`,
    };
  }

  // Pull retention preference. brand_briefs may not exist yet for very
  // new workspaces (onboarding-incomplete edge); default to false (the
  // privacy-preserving default).
  const { data: brief } = await svc
    .from("brand_briefs")
    .select("audio_retention_opt_in")
    .eq("workspace_id", ws.id)
    .maybeSingle();
  const keepAudio = Boolean(brief?.audio_retention_opt_in);

  // Best-effort filename + content-type. MediaRecorder on Chromium emits
  // webm/opus by default; Safari emits mp4 (m4a). Groq sniffs the MIME so
  // the extension matters more than the content-type header.
  const contentType = file.type || "audio/webm";
  const ext = pickExtension(contentType);
  const baseName = `${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;
  const filename = `voice-memo-${baseName}`;

  let audioStoragePath: string | undefined;

  if (keepAudio) {
    // Upload first so the recording is safe before we hit Groq. If Groq
    // fails we keep the blob and the user can retry transcription against
    // it later (a future slice — not in 2.6/2 scope).
    const storagePath = `${ws.id}/${baseName}`;
    const bytes = await file.arrayBuffer();
    const { error: upErr } = await svc.storage
      .from(AUDIO_BUCKET)
      .upload(storagePath, bytes, { contentType, upsert: false });
    if (upErr) {
      return {
        ok: false,
        error: `Couldn't save the recording: ${upErr.message}`,
      };
    }
    audioStoragePath = storagePath;
  }

  try {
    const result = await transcribeAudioRich(file, {
      filename,
      contentType,
      verbose: true,
    });
    return {
      ok: true,
      transcript: result.text,
      hints: result.hints,
      audioStoragePath,
    };
  } catch (err) {
    if (err instanceof TranscriptionUnavailableError) {
      return {
        ok: false,
        error:
          "Voice transcription isn't configured yet. Ask the operator to set GROQ_API_KEY.",
      };
    }
    if (err instanceof TranscriptionError) {
      return {
        ok: false,
        error: `Transcription failed: ${err.message}`,
      };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Unknown transcription error.",
    };
  }
}

function pickExtension(contentType: string): string {
  if (contentType.includes("webm")) return "webm";
  if (contentType.includes("mp4") || contentType.includes("m4a")) return "m4a";
  if (contentType.includes("wav")) return "wav";
  if (contentType.includes("mpeg") || contentType.includes("mp3")) return "mp3";
  if (contentType.includes("ogg")) return "ogg";
  return "webm";
}

// The "Generate week of posts" handoff lives in ./generate-action.ts —
// imported directly by the /record client. We keep that action in its own
// file so this file stays focused on the transcribe path and well under
// the 500-line ceiling.
