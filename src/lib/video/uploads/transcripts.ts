// Slice B — transcript read helpers + row↔domain mapper.
//
// Keeps the video_transcripts row→domain mapping in one place so the editor page
// (slice E) and any future consumer (the clip orchestrator that slices captions)
// read the same shape. Pure mapping + a service-role loader. No "use client".

import type { Json } from "@/lib/db/types";
import { supabaseService } from "@/lib/supabase/service";
import type {
  TranscriptSegment,
  VideoTranscript,
  VideoTranscriptRow,
} from "@/lib/video/uploads/types";

// `video_transcripts` (migration 068) isn't in the hand-maintained Database type
// yet (shared foundation file outside this slice). Loosely-typed `.from()` until
// it lands; rows are re-narrowed to VideoTranscriptRow below. See slice note.
type LooseFrom = { from: (table: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
function db() {
  return supabaseService() as unknown as LooseFrom;
}

// Narrow the jsonb `segments` column into TranscriptSegment[]. Defensive: the
// column is `Json`, so validate each entry and drop anything malformed.
export function rowSegmentsToDomain(raw: Json): TranscriptSegment[] {
  if (!Array.isArray(raw)) return [];
  const out: TranscriptSegment[] = [];
  for (const entry of raw) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const e = entry as Record<string, unknown>;
      const startMs = typeof e.start_ms === "number" ? e.start_ms : undefined;
      const endMs = typeof e.end_ms === "number" ? e.end_ms : undefined;
      const text = typeof e.text === "string" ? e.text : undefined;
      if (
        startMs !== undefined &&
        endMs !== undefined &&
        text !== undefined &&
        Number.isFinite(startMs) &&
        Number.isFinite(endMs)
      ) {
        out.push({ startMs, endMs, text });
      }
    }
  }
  return out;
}

// Map a DB row → in-app VideoTranscript.
export function mapTranscriptRow(row: VideoTranscriptRow): VideoTranscript {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    uploadedVideoId: row.uploaded_video_id,
    language: row.language,
    text: row.text,
    segments: rowSegmentsToDomain(row.segments),
    srt: row.srt,
    vtt: row.vtt,
    provider: row.provider,
    model: row.model,
    edited: row.edited,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Load a source video's transcript (service-role; one row per source via the
// UNIQUE constraint). Returns null when none exists yet. Callers in a request
// context should have already verified workspace ownership of the source.
export async function getTranscriptByUploadedVideo(
  uploadedVideoId: string,
): Promise<VideoTranscript | null> {
  const { data, error } = await db()
    .from("video_transcripts")
    .select("*")
    .eq("uploaded_video_id", uploadedVideoId)
    .maybeSingle();
  if (error) {
    throw new Error(`getTranscriptByUploadedVideo failed: ${error.message}`);
  }
  if (!data) return null;
  return mapTranscriptRow(data as VideoTranscriptRow);
}
