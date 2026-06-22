// Shared types for the user-video-upload feature (migration 068).
//
// One file the six builder slices import from so the row shapes, domain shapes,
// and the MPT clip-job contract never drift. Convention (matches src/lib/db
// + src/lib/video/jobs.ts): snake_case `*Row` types mirror the DB columns
// exactly; camelCase domain types are the in-app shape; mappers bridge them.

import type { Json } from "@/lib/db/types";

// ─────────────────────────────────────────────────────────────
// Bucket name
// ─────────────────────────────────────────────────────────────
// The raw-source bucket created in migration 068. Sources live at
// `<workspace_id>/<uploadedVideoId>/source.<ext>`. Cut CLIP OUTPUTS reuse the
// existing post-media-video bucket (see poll-video-jobs cron), NOT this one.
export const SOURCE_VIDEO_BUCKET = "source-video";

// ─────────────────────────────────────────────────────────────
// uploaded_videos
// ─────────────────────────────────────────────────────────────
export type UploadedVideoStatus = "uploading" | "ready" | "failed";

// Mirrors public.uploaded_videos exactly.
export interface UploadedVideoRow {
  id: string;
  workspace_id: string;
  uploaded_by: string | null;
  storage_path: string;
  original_filename: string | null;
  content_type: string | null;
  size_bytes: number | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  status: UploadedVideoStatus;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

// In-app shape of a raw uploaded source video.
export interface UploadedVideo {
  id: string;
  workspaceId: string;
  uploadedBy: string | null;
  storagePath: string;
  originalFilename: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  status: UploadedVideoStatus;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─────────────────────────────────────────────────────────────
// Transcript segments
// ─────────────────────────────────────────────────────────────
// One timestamped chunk of speech. Timestamps are MILLISECONDS from the start
// of the source video (ints) — captions.ts formats them to SRT/VTT and slices
// them per clip. Stored as the jsonb array in video_transcripts.segments.
export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
}

// The persisted jsonb shape (snake_case) of a single segment row entry.
export interface TranscriptSegmentRow {
  start_ms: number;
  end_ms: number;
  text: string;
}

// ─────────────────────────────────────────────────────────────
// video_transcripts
// ─────────────────────────────────────────────────────────────
// Mirrors public.video_transcripts exactly. `segments` is the jsonb array of
// TranscriptSegmentRow; typed as Json[] at the DB boundary, narrowed by the
// mapper.
export interface VideoTranscriptRow {
  id: string;
  workspace_id: string;
  uploaded_video_id: string;
  language: string | null;
  text: string | null;
  segments: Json;
  srt: string | null;
  vtt: string | null;
  provider: string | null;
  model: string | null;
  edited: boolean;
  created_at: string;
  updated_at: string;
}

// In-app shape of a source video's transcript.
export interface VideoTranscript {
  id: string;
  workspaceId: string;
  uploadedVideoId: string;
  language: string | null;
  text: string | null;
  segments: TranscriptSegment[];
  srt: string | null;
  vtt: string | null;
  provider: string | null;
  model: string | null;
  edited: boolean;
  createdAt: string;
  updatedAt: string;
}

// ─────────────────────────────────────────────────────────────
// Clip spec + clip-cut job params
// ─────────────────────────────────────────────────────────────
// One clip the user wants cut out of a source video. `startMs`/`endMs` are
// milliseconds into the source; `burnCaptions` toggles hard-subtitle burn-in.
// `label` is a filesystem-safe slug used for the output filename
// (`<task_id>/<label>.mp4`) and as the clip_label on the video_jobs row.
export interface ClipSpec {
  label: string;
  startMs: number;
  endMs: number;
  burnCaptions: boolean;
}

// The discriminant + payload stored on video_jobs.params for a clip-cut job.
// poll-video-jobs routes on params.kind; 'user_clip' is this feature's branch.
// `subtitlesSrt` is the per-clip SRT (already re-based to the clip window via
// captions.sliceSegments) sent to MPT only when burnCaptions is true.
export interface ClipJobParams {
  kind: "user_clip";
  uploadedVideoId: string;
  label: string;
  startMs: number;
  endMs: number;
  burnCaptions: boolean;
  subtitlesSrt?: string;
  // Optional output aspect hint passed through to MPT (e.g. "9:16"). When
  // omitted MPT keeps the source aspect.
  aspect?: string;
}
