# User video upload — design doc

Status: FOUNDATION landed (migration 068, shared types, captions helper, env
flag). Builder slices A–F to follow. Gated behind `USER_VIDEO_UPLOAD_ENABLED`
(`userVideoUploadEnabled()` in `src/lib/env.ts`) — off by default; ships dark.

## What this is

A user uploads their OWN raw video (a screen recording, a phone clip, a webinar
export). We:

1. Store the raw bytes in a private `source-video` bucket.
2. Auto-transcribe it (Groq Whisper) into timestamped segments + SRT/VTT, which
   the user can edit in place.
3. Let the user mark up one or more **clip ranges** (`startMs`/`endMs`, a label,
   and a "burn captions" toggle).
4. Have the **MPT worker** cut each clip frame-accurately (and optionally burn
   the per-clip subtitles), pull the finished mp4 into the existing
   `post-media-video` bucket, and attach it to a draft post — reusing the same
   `video_jobs` + poll-cron + dispatch machinery every other video path uses.

This is distinct from MPT's Pexels-stitch pipeline (026) and the reference-image
/ avatar path (030): the source footage is the user's own, MPT only **cuts**
(and burns captions), it does not generate.

## Data model (migration 068)

- **Bucket `source-video`** (private, 2GB cap, mp4/mov/webm). Layout
  `<workspace_id>/<uploadedVideoId>/source.<ext>`. RLS identical in shape to
  `post-media-video`: `split_part(name,'/',1)::uuid = workspace` +
  `is_workspace_member`. Service role bypasses (orchestrator signs a GET URL for
  MPT; poll cron deletes the source after clips are produced). Clip OUTPUTS reuse
  the existing `post-media-video` bucket — NOT this one.
- **`uploaded_videos`** — one row per raw upload: `storage_path`, probed
  `duration_seconds`/`width`/`height`/`size_bytes`, `status`
  (`uploading`→`ready`|`failed`). Workspace-scoped RLS.
- **`video_transcripts`** — one transcript per source (UNIQUE
  `uploaded_video_id`; user edits in place, `edited=true`). `segments` jsonb is
  an array of `{start_ms,end_ms,text}`; `srt`/`vtt` are pre-rendered for burn-in
  + browser `<track>`. Workspace-scoped RLS.
- **`video_jobs` clip columns** (additive, nullable): `uploaded_video_id`,
  `clip_label`, `clip_start_ms`, `clip_end_ms`, `burn_captions`. Clip-cut jobs
  REUSE `video_jobs` and discriminate on `params.kind = 'user_clip'`. No clips
  table.

## Shared types — `src/lib/video/uploads/types.ts`

Single import surface for all six slices. Key exports:

- `SOURCE_VIDEO_BUCKET` const (`"source-video"`).
- `UploadedVideoRow` / `UploadedVideo` (snake_case row ↔ camelCase domain),
  `UploadedVideoStatus`.
- `TranscriptSegment` (`{startMs,endMs,text}`) + `TranscriptSegmentRow`
  (`{start_ms,end_ms,text}`).
- `VideoTranscriptRow` / `VideoTranscript`.
- `ClipSpec` (`{label,startMs,endMs,burnCaptions}`).
- `ClipJobParams` (`{kind:'user_clip', uploadedVideoId, label, startMs, endMs,
  burnCaptions, subtitlesSrt?, aspect?}`) — what goes on `video_jobs.params`.

## Captions helper — `src/lib/video/uploads/captions.ts` (pure, unit-tested)

- `segmentsToSrt(segments)` → SRT (`HH:MM:SS,mmm`, comma, 1-indexed blocks).
- `segmentsToVtt(segments)` → WebVTT (`WEBVTT` header, `HH:MM:SS.mmm`, dot).
- `sliceSegments(segments, startMs, endMs)` → segments overlapping the clip
  window, re-based to t=0 and clamped to the window length. Used to build the
  per-clip `subtitlesSrt` (slice → `segmentsToSrt`) sent to MPT.

Covered by `tests/unit/uploads-captions.test.ts` (16 tests).

## End-to-end flow

```
USER                MM (Next.js)                 Supabase                 MPT worker
 │  pick file  ──────►│                              │                        │
 │                    │ insert uploaded_videos       │                        │
 │                    │   (status='uploading')  ────►│                        │
 │  upload bytes ─────┼──────────────────────────────► source-video bucket     │
 │                    │ probe + mark 'ready'    ────►│                        │
 │                    │ POST /api/v1/extract-audio (signed source GET URL) ───►│  cut audio
 │                    │ poll /tasks → download audio.m4a ◄──────────────────── │
 │                    │ transcribeAudio() → segments + SRT/VTT                 │
 │                    │ upsert video_transcripts ───►│                        │
 │  edit transcript / │                              │                        │
 │  mark clip ranges ►│ upsert video_transcripts     │                        │
 │  "Make clips"  ───►│ for each ClipSpec:           │                        │
 │                    │   subtitlesSrt = segmentsToSrt(sliceSegments(...))     │
 │                    │   createJob(params:user_clip + clip cols)   ────►│     │
 │                    │ orchestrator: sign source GET URL                     │
 │                    │   POST /api/v1/clip {source_url, clips, aspect} ─────► │  ffmpeg cut (+burn)
 │                    │   markProcessing(mpt_task_id)                         │
 │  (cron, every min) │ poll-video-jobs: GET /tasks/{id}  ◄─────────────────── │
 │                    │   on COMPLETE: download <task>/<label>.mp4            │
 │                    │   upload → post-media-video bucket                    │
 │                    │   attach draft post (dedup gate) → markReady          │
 │                    │   DELETE /tasks + delete source-video object          │
 │  draft post w/ clip│◄─────────────────────────────│                        │
```

Long-source note: Groq/OpenAI audio endpoints cap ~25MB. For anything longer we
do NOT send the raw video to Whisper — we ask MPT to extract a compact
`audio.m4a` first (`POST /api/v1/extract-audio`), download it, then transcribe.
`src/lib/sources/transcribe.ts` (`transcribeAudioRich`) returns the segments; the
ms-timestamp mapping is the transcription slice's job.

## MPT contract (for the Python + client builders — NOT implemented here)

Two new endpoints on `services/mpt-worker`, reusing the EXISTING task state
machine (`GET /api/v1/tasks/{id}` → `{state, progress, videos[]}`,
`GET /api/v1/download/{id}/{file}`, `DELETE /api/v1/tasks/{id}`,
`x-api-key` header). MM passes a **Supabase signed GET URL** to the source object;
MPT fetches the source itself (it has no Supabase creds).

### `POST /api/v1/clip`

Request body:

```json
{
  "source_url": "https://…signed-get-url…/source.mp4",
  "clips": [
    {
      "label": "hook",
      "start_ms": 1500,
      "end_ms": 9000,
      "burn_captions": true,
      "subtitles_srt": "1\n00:00:00,000 --> 00:00:02,000\n…\n"
    }
  ],
  "aspect": "9:16"
}
```

Response: `{ "data": { "task_id": "<id>" } }` (same envelope as
`POST /api/v1/videos`).

Behaviour per clip:
- Cut `[start_ms, end_ms)` with `ffmpeg -ss <start> -to <end>` **re-encoding**
  (not stream-copy) for frame accuracy.
- If `burn_captions` is true: write `subtitles_srt` to a temp `.srt` and burn it
  with `-vf subtitles=<file>` (subtitles are already re-based to the clip window
  by MM via `sliceSegments`, so timestamps start at 0).
- Output each finished clip at `<task_id>/<label>.mp4`, surfaced in the task's
  `videos[]` exactly like the render endpoint, so the existing poll cron +
  `fileNameFromVideoPath()` consume it unchanged.
- `aspect` (optional, `"9:16"`/`"16:9"`/`"1:1"`): pad/crop to that aspect; when
  omitted keep the source aspect.

### `POST /api/v1/extract-audio`

Request body: `{ "source_url": "https://…signed-get-url…" }`.
Response: `{ "data": { "task_id": "<id>" } }`.
Output `<task_id>/audio.m4a` (mono AAC, ~64–96kbps — small enough for Whisper),
downloadable via the existing `GET /api/v1/download/{task_id}/audio.m4a`.

## File-ownership map (6 builder slices)

Each slice owns its listed files; shared types/captions/env are READ-ONLY for
all slices (foundation owns them). `video_jobs.ts` gets a small additive edit
(clip columns in `CreateJobInput`/`VideoJobRow`) owned by slice D.

### A) upload-flow
Direct browser upload to `source-video` + `uploaded_videos` lifecycle + probe.
- `src/app/(app)/video/upload/page.tsx`
- `src/app/(app)/video/upload/upload-form.tsx`
- `src/app/(app)/video/upload/actions.ts`
- `src/lib/video/uploads/uploaded-videos.ts` (CRUD: create/markReady/markFailed/get/list)
- `tests/unit/uploaded-videos.test.ts`

### B) transcription
Extract-audio → Whisper → segments(ms) + SRT/VTT → `video_transcripts` upsert + edit.
- `src/lib/video/uploads/transcripts.ts` (CRUD + upsert)
- `src/lib/video/uploads/transcribe-source.ts` (extract-audio orchestration → segments)
- `src/app/(app)/video/upload/[id]/transcript-actions.ts` (save edited transcript)
- `tests/unit/source-transcribe.test.ts`

### C) mpt-python
The two MPT endpoints + ffmpeg.
- `services/mpt-worker/app/router.py` (routes)
- `services/mpt-worker/app/controllers/clip.py`
- `services/mpt-worker/app/services/clip.py` (ffmpeg cut + burn)
- `services/mpt-worker/app/services/extract_audio.py`
- `services/mpt-worker/app/models/clip.py` (request/response schemas)
- `services/mpt-worker/test/test_clip.py`

### D) mpt-client + orchestrator + poll-cron
MM-side wiring of the clip job lifecycle.
- `src/lib/video/mpt-client.ts` (add `createClipJob`, `extractAudio`)
- `src/lib/video/uploads/clip-orchestrator.ts` (`startClipRender`: sign URL, build
  `subtitlesSrt`, createJob + clip cols, POST /clip, markProcessing)
- `src/lib/video/jobs.ts` (additive: clip cols in `CreateJobInput`/`VideoJobRow`)
- `src/app/api/cron/poll-video-jobs/route.ts` (route `params.kind='user_clip'`:
  download `<task>/<label>.mp4`, source cleanup)
- `tests/unit/clip-orchestrator.test.ts`, `tests/unit/poll-video-jobs-clip-branch.test.ts`

### E) clip-editor-UI
Transcript view + clip range marking + "make clips" trigger + job list.
- `src/app/(app)/video/upload/[id]/page.tsx`
- `src/app/(app)/video/upload/[id]/clip-editor.tsx` (player + range picker + captions toggle)
- `src/app/(app)/video/upload/[id]/transcript-panel.tsx` (editable transcript)
- `src/app/(app)/video/upload/[id]/clip-actions.ts` (validate ClipSpec[] → startClipRender)
- add an "Upload" tab to `src/app/(app)/video/video-mode-tabs.tsx`

### F) marketing
Positioning + copy for "turn your long video into clips".
- `docs/launch/user-video-upload.md` (launch notes)
- homepage / `/video` feature copy (existing marketing surfaces — additive copy only)

## Foundation files (owned here; READ-ONLY for slices A–F)

- `supabase/migrations/068_user_video_upload.sql`
- `src/lib/video/uploads/types.ts`
- `src/lib/video/uploads/captions.ts`
- `tests/unit/uploads-captions.test.ts`
- `src/lib/env.ts` (`USER_VIDEO_UPLOAD_ENABLED` + `userVideoUploadEnabled()`)
- `docs/designs/user-video-upload.md` (this doc)
