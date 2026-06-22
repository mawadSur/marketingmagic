-- marketingmagic · 068 — User video upload (BYO clips → captions → cut → post)
--
-- Lets a user upload their OWN raw video, get it auto-transcribed, mark up
-- caption-able clip ranges, and have MPT cut (and optionally burn-caption) each
-- clip — then attach the result to a draft post like every other video path.
-- Gated behind USER_VIDEO_UPLOAD_ENABLED at the application layer
-- (userVideoUploadEnabled() in src/lib/env.ts).
--
-- Four things land here:
--
--   1. Storage bucket `source-video` — holds the user's RAW uploaded video under
--      `<workspace_id>/<uploaded_video_id>/source.<ext>`. Mirrors the RLS shape
--      of post-media-video (026) / reference-image (030): split_part(name,'/',1)
--      → workspace_id, workspace-member read/write, service-role bypass (the MPT
--      orchestrator hands MPT a signed GET URL to this object; the poll cron
--      cleans it up). Generous 2GB cap + mp4/mov/webm. Cut CLIP OUTPUTS reuse the
--      EXISTING post-media-video bucket — this bucket is sources only.
--
--   2. Table `uploaded_videos` — one row per raw upload. Tracks the storage path
--      + probed metadata (duration/dimensions/size) + a small status machine
--      (uploading → ready | failed). Workspace-scoped RLS.
--
--   3. Table `video_transcripts` — one transcript per uploaded source (UNIQUE on
--      uploaded_video_id; the user edits it in place). Holds the Whisper segments
--      (with ms timestamps) plus pre-rendered SRT/VTT for burn-in + display.
--      Workspace-scoped RLS.
--
--   4. `video_jobs` clip columns — clip-cut jobs REUSE 026's video_jobs and
--      discriminate on params.kind = 'user_clip'. A handful of nullable columns
--      carry the per-clip spec for cheap lookups + cleanup. Additive + nullable,
--      so backward-compatible with every existing video_jobs row.

-- ─────────────────────────────────────────────────────────────
-- 1. Storage bucket: source-video
-- ─────────────────────────────────────────────────────────────
-- Layout: storage objects are written under
-- `<workspace_id>/<uploaded_video_id>/source.<ext>`. RLS mirrors
-- post-media-video (026): workspace members read/write their own prefix;
-- service role bypasses RLS (the orchestrator signs a GET URL for MPT to fetch
-- and the poll cron deletes the source once clips are produced).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'source-video',
  'source-video',
  false,  -- PRIVATE: raw user footage. MPT fetches via a short-lived signed GET URL.
  2147483648,  -- 2GB cap. Raw phone/screen-capture footage is large; generous headroom.
  array['video/mp4', 'video/quicktime', 'video/webm']
)
on conflict (id) do nothing;

-- Workspace-scoped read.
create policy "source-video: members read own workspace"
  on storage.objects for select
  using (
    bucket_id = 'source-video'
    and public.is_workspace_member((split_part(name, '/', 1))::uuid)
  );

-- Workspace-scoped write.
create policy "source-video: members write own workspace"
  on storage.objects for insert
  with check (
    bucket_id = 'source-video'
    and public.is_workspace_member((split_part(name, '/', 1))::uuid)
  );

create policy "source-video: members update own workspace"
  on storage.objects for update
  using (
    bucket_id = 'source-video'
    and public.is_workspace_member((split_part(name, '/', 1))::uuid)
  );

create policy "source-video: members delete own workspace"
  on storage.objects for delete
  using (
    bucket_id = 'source-video'
    and public.is_workspace_member((split_part(name, '/', 1))::uuid)
  );

-- ─────────────────────────────────────────────────────────────
-- 2. uploaded_videos
-- ─────────────────────────────────────────────────────────────
-- One row per raw source upload. The bytes live in the source-video bucket;
-- this row is the metadata + lifecycle record. `status` mirrors the
-- string-as-enum convention used by video_jobs.
create table if not exists public.uploaded_videos (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- Who uploaded it (audit). ON DELETE SET NULL so removing a teammate keeps
  -- the upload's audit trail rather than cascading the upload away.
  uploaded_by uuid references auth.users(id) on delete set null,
  -- `<workspace_id>/<uploaded_video_id>/source.<ext>` in the source-video bucket.
  storage_path text not null,
  original_filename text,
  content_type text,
  size_bytes bigint,
  -- Probed metadata, populated once the upload is finalised. Nullable until then.
  duration_seconds numeric,
  width int,
  height int,
  -- Lifecycle: uploading (row inserted, bytes may still be landing) → ready
  -- (bytes confirmed in the bucket) | failed (upload/probe error).
  status text not null default 'uploading'
    check (status in ('uploading', 'ready', 'failed')),
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists uploaded_videos_workspace_idx
  on public.uploaded_videos(workspace_id);

create trigger uploaded_videos_set_updated_at
  before update on public.uploaded_videos
  for each row execute function public.set_updated_at();

alter table public.uploaded_videos enable row level security;

create policy "Members read uploaded videos"
  on public.uploaded_videos for select
  using (public.is_workspace_member(workspace_id));

create policy "Members manage uploaded videos"
  on public.uploaded_videos for all
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
-- Service role (orchestrator + poll cron) bypasses RLS entirely.

-- ─────────────────────────────────────────────────────────────
-- 3. video_transcripts
-- ─────────────────────────────────────────────────────────────
-- One transcript per uploaded source (UNIQUE on uploaded_video_id). The user
-- edits the text in place (edited=true), so we keep a single row and overwrite
-- rather than versioning. `segments` is an array of {start_ms,end_ms,text};
-- `srt`/`vtt` are pre-rendered from those segments for burn-in + display.
create table if not exists public.video_transcripts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  uploaded_video_id uuid not null
    references public.uploaded_videos(id) on delete cascade,
  -- BCP-47-ish language hint Whisper detected/used (e.g. 'en'). Nullable.
  language text,
  -- The full plain-text transcript.
  text text,
  -- Array of {start_ms,end_ms,text} — the timestamped segments captions ride on.
  segments jsonb not null default '[]'::jsonb,
  -- Pre-rendered subtitle bodies. `srt` is what MPT burns via -vf subtitles;
  -- `vtt` is what the browser <track> uses for live preview.
  srt text,
  vtt text,
  -- Provenance: which engine/model produced this (e.g. 'groq' /
  -- 'whisper-large-v3-turbo'). Null for a fully hand-entered transcript.
  provider text,
  model text,
  -- True once the user has hand-edited the auto-transcript.
  edited boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (uploaded_video_id)
);

create index if not exists video_transcripts_workspace_idx
  on public.video_transcripts(workspace_id);
create index if not exists video_transcripts_uploaded_video_idx
  on public.video_transcripts(uploaded_video_id);

create trigger video_transcripts_set_updated_at
  before update on public.video_transcripts
  for each row execute function public.set_updated_at();

alter table public.video_transcripts enable row level security;

create policy "Members read video transcripts"
  on public.video_transcripts for select
  using (public.is_workspace_member(workspace_id));

create policy "Members manage video transcripts"
  on public.video_transcripts for all
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
-- Service role (transcription worker) bypasses RLS entirely.

-- ─────────────────────────────────────────────────────────────
-- 4. video_jobs clip columns
-- ─────────────────────────────────────────────────────────────
-- Clip-cut jobs REUSE 026's video_jobs and discriminate on
-- params.kind = 'user_clip' (no separate clips table — that would duplicate the
-- whole status machine). These nullable columns carry the per-clip spec so the
-- cron + cleanup can look it up without re-parsing params. Additive + nullable,
-- so backward-compatible with every existing video_jobs row.
alter table public.video_jobs
  add column if not exists uploaded_video_id uuid
    references public.uploaded_videos(id) on delete set null;
alter table public.video_jobs
  add column if not exists clip_label text;
alter table public.video_jobs
  add column if not exists clip_start_ms int;
alter table public.video_jobs
  add column if not exists clip_end_ms int;
alter table public.video_jobs
  add column if not exists burn_captions boolean;

create index if not exists video_jobs_uploaded_video_idx
  on public.video_jobs(uploaded_video_id);
