-- marketingmagic · 026 — Video pipeline (Phase 2 / P2)
--
-- Integrates MoneyPrinterTurbo (MPT) as an external "bring-your-own-key"
-- render worker. Customers supply their OWN LLM + Pexels keys; MM
-- orchestrates the render over HTTP, then pulls the finished mp4 into a
-- Supabase Storage bucket and attaches it to a DRAFT post.
--
-- Three things land here:
--
--   1. Storage bucket `post-media-video` — holds rendered mp4s under
--      `<workspace_id>/<job_id>/<file>`. Mirrors the RLS shape of
--      003_post_media_bucket.sql (split_part on the path → workspace_id),
--      with a 200MB cap and video mime types.
--
--   2. Table `video_jobs` — one row per render request. Tracks the MPT
--      task id + progress; the poll-video-jobs cron walks processing rows.
--      Workspace-scoped RLS for reads/writes; service-role bypasses for the
--      cron. The actual BYO secrets are NOT stored here — only opaque
--      `params` (subject/script/aspect/etc.).
--
--   3. Table `workspace_byo_keys` — per-(workspace, provider) encrypted
--      credentials. Ciphertext is produced in Node (AES-256-GCM via
--      BYO_ENCRYPTION_KEY); the DB only ever sees opaque bytes. SERVICE-ROLE
--      ONLY — clients must never read this table, so it has RLS enabled
--      with NO public policies (every authenticated query returns zero rows).

-- ─────────────────────────────────────────────────────────────
-- 1. Storage bucket: post-media-video
-- ─────────────────────────────────────────────────────────────
-- Layout: storage objects are written under `<workspace_id>/<job_id>/<filename>`.
-- RLS mirrors post-media (003): workspace members read/write their own
-- prefix; service role bypasses RLS (the poll-video-jobs cron streams the
-- finished mp4 in, and dispatch later reads bytes out to publish).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'post-media-video',
  'post-media-video',
  true,
  209715200,  -- 200MB cap. MPT shorts are typically <50MB; headroom for 16:9 longer clips.
  array['video/mp4', 'video/quicktime']
)
on conflict (id) do nothing;

-- Workspace-scoped read.
create policy "post-media-video: members read own workspace"
  on storage.objects for select
  using (
    bucket_id = 'post-media-video'
    and public.is_workspace_member((split_part(name, '/', 1))::uuid)
  );

-- Workspace-scoped write.
create policy "post-media-video: members write own workspace"
  on storage.objects for insert
  with check (
    bucket_id = 'post-media-video'
    and public.is_workspace_member((split_part(name, '/', 1))::uuid)
  );

create policy "post-media-video: members update own workspace"
  on storage.objects for update
  using (
    bucket_id = 'post-media-video'
    and public.is_workspace_member((split_part(name, '/', 1))::uuid)
  );

create policy "post-media-video: members delete own workspace"
  on storage.objects for delete
  using (
    bucket_id = 'post-media-video'
    and public.is_workspace_member((split_part(name, '/', 1))::uuid)
  );

-- ─────────────────────────────────────────────────────────────
-- 2. video_jobs
-- ─────────────────────────────────────────────────────────────
create table if not exists public.video_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- Optional target channel for the eventual publish. Nullable because a
  -- render can be kicked off before the user has picked a destination.
  social_account_id uuid references public.social_accounts(id) on delete set null,
  -- The DRAFT post the finished video gets attached to. Populated by the
  -- cron when the render completes (create-or-update). Nullable until then.
  post_id uuid references public.posts(id) on delete set null,
  -- Lifecycle: pending (row inserted) → processing (MPT accepted the task)
  -- → ready (mp4 stored + draft post written) | failed (MPT state -1 or a
  -- transport error). Mirrors the string-as-enum convention used elsewhere.
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'ready', 'failed')),
  -- The MPT task id returned by POST /api/v1/videos. Null until the render
  -- request succeeds; the poll cron keys GET /api/v1/tasks/{id} off this.
  mpt_task_id text,
  -- Opaque render parameters (video_subject, video_script, aspect, voice,
  -- counts, etc.). Never contains BYO secrets — those are decrypted at
  -- dispatch time and sent straight to MPT, never persisted here.
  params jsonb not null default '{}'::jsonb,
  -- 0..100, surfaced in the UI (P4). MPT reports its own progress integer.
  progress int not null default 0,
  -- `<workspace_id>/<job_id>/final.mp4` once the mp4 lands in the bucket.
  storage_path text,
  -- Free-form failure reason (MPT FAILED state, download error, etc.).
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists video_jobs_status_idx on public.video_jobs(status);
create index if not exists video_jobs_workspace_idx on public.video_jobs(workspace_id);

create trigger video_jobs_set_updated_at
  before update on public.video_jobs
  for each row execute function public.set_updated_at();

alter table public.video_jobs enable row level security;

create policy "Members can read video jobs"
  on public.video_jobs for select
  using (public.is_workspace_member(workspace_id));

create policy "Members can write video jobs"
  on public.video_jobs for all
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
-- Service role (cron + orchestrator) bypasses RLS entirely.

-- ─────────────────────────────────────────────────────────────
-- 3. workspace_byo_keys
-- ─────────────────────────────────────────────────────────────
-- Encrypted bring-your-own credentials, one row per (workspace, provider).
-- `provider` is the credential family, e.g. 'llm' or 'pexels'. The
-- ciphertext is an opaque AES-256-GCM blob (iv:tag:ciphertext, base64,
-- produced in Node) — the DB never sees plaintext and clients never read
-- this table at all.
create table if not exists public.workspace_byo_keys (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider text not null,
  ciphertext text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (workspace_id, provider)
);

create index if not exists workspace_byo_keys_workspace_idx
  on public.workspace_byo_keys(workspace_id);

-- SERVICE-ROLE ONLY. RLS is enabled with no public policies, so any
-- authenticated/anon query returns zero rows. The only access path is the
-- service-role client in src/lib/video/byo-keys.ts, which bypasses RLS.
alter table public.workspace_byo_keys enable row level security;
