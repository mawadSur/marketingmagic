"use server";

// Slice B — transcript edit server action.
//
// `saveTranscriptEditAction(uploadedVideoId, payload)` lets the user correct the
// auto-transcript before it's used for caption burn-in. The payload is EITHER:
//   - { segments } — the edited timestamped segments (the structured editor), or
//   - { text }     — a plain rewrite (we keep the existing segment timings if we
//                    have them, otherwise store a single text-only transcript).
// Either way we re-derive SRT/VTT from the resulting segments and set
// `edited=true` so the UI shows the transcript is hand-curated.
//
// Auth: the active workspace must OWN the uploaded video (membership is implied
// by getActiveWorkspaceOrRedirect; we additionally assert the source row's
// workspace_id matches so a user can't edit another workspace's transcript by
// id). Writes go through the service-role client (transcripts are service-owned)
// only AFTER that ownership check.

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { userVideoUploadEnabled } from "@/lib/env";
import { getAuthedUserOrRedirect, getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseService } from "@/lib/supabase/service";
import {
  segmentsToSrt,
  segmentsToVtt,
} from "@/lib/video/uploads/captions";
import type { TranscriptSegment } from "@/lib/video/uploads/types";

export type SaveTranscriptState = { error: string | null; success: string | null };

// Boundary validation. Timestamps are non-negative ms ints; text is bounded so
// a pathological paste can't blow the row up. end > start is enforced after
// parse (zod refine per item).
const segmentSchema = z
  .object({
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(0),
    text: z.string().max(5000),
  })
  .refine((s) => s.endMs > s.startMs, { message: "endMs must be after startMs" });

const payloadSchema = z
  .object({
    // At least one of the two must be present. Validated in the refine below.
    text: z.string().max(200_000).optional(),
    segments: z.array(segmentSchema).max(5000).optional(),
  })
  .refine((p) => p.text !== undefined || (p.segments && p.segments.length > 0), {
    message: "Provide edited text or segments.",
  });

export type SaveTranscriptPayload = z.infer<typeof payloadSchema>;

// Re-derive the segment array we'll persist + caption from. When the editor
// hands us structured `segments`, those win. When it hands us only `text`, we
// keep the EXISTING segment timings (so captions still line up) but replace
// their text proportionally is overkill — instead we keep the prior segments
// untouched and just overwrite the plain `text`. A pure text rewrite with no
// prior segments yields an empty segment list (text-only transcript, no
// burn-in until the user adds timings).
function resolveSegments(
  payload: SaveTranscriptPayload,
  priorSegments: TranscriptSegment[],
): TranscriptSegment[] {
  if (payload.segments && payload.segments.length > 0) {
    return payload.segments.map((s) => ({
      startMs: s.startMs,
      endMs: s.endMs,
      text: s.text.trim(),
    }));
  }
  // Text-only edit: preserve existing timings.
  return priorSegments;
}

export async function saveTranscriptEditAction(
  uploadedVideoId: string,
  payload: SaveTranscriptPayload,
): Promise<SaveTranscriptState> {
  if (!userVideoUploadEnabled()) {
    return { error: "Video upload isn't enabled on this deployment yet.", success: null };
  }

  if (typeof uploadedVideoId !== "string" || uploadedVideoId.length === 0) {
    return { error: "Missing video id.", success: null };
  }

  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid transcript.", success: null };
  }

  await getAuthedUserOrRedirect();
  const ws = await getActiveWorkspaceOrRedirect();

  // `uploaded_videos` / `video_transcripts` (migration 068) aren't in the
  // hand-maintained Database type yet (shared foundation file outside this
  // slice), so go through a loosely-typed `.from()`. See slice return note.
  const svc = supabaseService() as unknown as {
    from: (table: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
  };

  // Ownership check: the source video must belong to the ACTIVE workspace.
  const { data: video, error: vErr } = await svc
    .from("uploaded_videos")
    .select("id, workspace_id")
    .eq("id", uploadedVideoId)
    .maybeSingle();
  if (vErr) return { error: "Couldn't load the video.", success: null };
  if (!video || video.workspace_id !== ws.id) {
    return { error: "Video not found in this workspace.", success: null };
  }

  // Load any existing transcript so a text-only edit can keep prior timings.
  const { data: existing } = await svc
    .from("video_transcripts")
    .select("segments, language, provider, model")
    .eq("uploaded_video_id", uploadedVideoId)
    .maybeSingle();

  const priorSegments = toSegments(existing?.segments);
  const segments = resolveSegments(parsed.data, priorSegments);

  // Resulting plain text: explicit text wins; else join the segments.
  const text =
    parsed.data.text !== undefined
      ? parsed.data.text.trim()
      : segments.map((s) => s.text).join(" ").trim();

  const srt = segmentsToSrt(segments);
  const vtt = segmentsToVtt(segments);
  const segmentRows = segments.map((s) => ({
    start_ms: s.startMs,
    end_ms: s.endMs,
    text: s.text,
  }));

  const { error: upErr } = await svc
    .from("video_transcripts")
    .upsert(
      {
        workspace_id: ws.id,
        uploaded_video_id: uploadedVideoId,
        language: existing?.language ?? null,
        text: text.length > 0 ? text : null,
        segments: segmentRows,
        srt: srt.length > 0 ? srt : null,
        vtt,
        provider: existing?.provider ?? null,
        model: existing?.model ?? null,
        edited: true,
      },
      { onConflict: "uploaded_video_id" },
    );
  if (upErr) return { error: "Couldn't save the transcript.", success: null };

  revalidatePath(`/video/upload/${uploadedVideoId}`);
  return { error: null, success: "Transcript saved." };
}

// Narrow the jsonb `segments` column back into TranscriptSegment[]. Defensive:
// the DB column is `Json`, so we validate each entry's shape and skip junk.
function toSegments(raw: unknown): TranscriptSegment[] {
  if (!Array.isArray(raw)) return [];
  const out: TranscriptSegment[] = [];
  for (const entry of raw) {
    if (entry && typeof entry === "object") {
      const e = entry as Record<string, unknown>;
      const startMs = typeof e.start_ms === "number" ? e.start_ms : undefined;
      const endMs = typeof e.end_ms === "number" ? e.end_ms : undefined;
      const text = typeof e.text === "string" ? e.text : undefined;
      if (startMs !== undefined && endMs !== undefined && text !== undefined && endMs > startMs) {
        out.push({ startMs, endMs, text });
      }
    }
  }
  return out;
}
