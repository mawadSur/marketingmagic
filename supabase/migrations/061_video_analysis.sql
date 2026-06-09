-- marketingmagic · 061 — video analysis (Hormozi slice 2: BYO-key hook breakdown)
--
-- THE DIRECT-RESPONSE HOOK BREAKDOWN (Hormozi video strategy, slice #2).
-- For a short-form video this stores the result of one analysis pass:
--   - `transcript`        — the spoken audio, transcribed.
--   - `visual_breakdown`  — structured JSON: what's on screen in the first 5s,
--                           pattern interrupts, on-screen text / captions.
--   - `hook_spoken`       — the spoken hook (the words in the first ~3s).
--   - `hook_visual`       — the visual hook (what the eye lands on first).
--   - `raw`               — the verbatim provider response, for re-parsing later.
--
-- BYO-KEY + USER-CHOSEN MODEL (like MPT / Higgsfield). There is NO central API
-- cost: the workspace supplies its own analysis-provider key and picks its own
-- model (Gemini native-video is the recommended default — Claude has no video
-- input type). `provider` + `model` record which backend produced THIS row, so a
-- workspace can switch models over time and the history stays attributable. The
-- key itself lives encrypted in workspace_byo_keys (provider 'analysis'), never
-- here.
--
-- SCOPE (v1): our-rendered videos only — bytes we own in the post-media-video
-- bucket (no TTL). `media_storage_path` points at that object. Organic videos
-- posted outside our pipeline (we have only an external id, not bytes) are
-- deferred — see analyzePostVideo()'s TODO.
--
-- One post can be re-analysed (different model, re-run), so this is a child
-- table of `posts` keyed by post_id; a fresh run UPSERTs over the prior row.

-- ─────────────────────────────────────────────────────────────
-- video_analysis — one DR hook breakdown per analysed post video
-- ─────────────────────────────────────────────────────────────
create table if not exists public.video_analysis (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- The post whose rendered video was analysed. ON DELETE CASCADE: the breakdown
  -- is meaningless without the post, so it goes when the post is hard-deleted.
  post_id uuid references public.posts(id) on delete cascade,
  -- Path of the analysed mp4 in the post-media-video bucket. Records exactly
  -- which asset this breakdown describes (a post's media can change).
  media_storage_path text,
  -- The transcribed spoken audio.
  transcript text,
  -- Structured visual annotation (first-5s elements, pattern interrupts,
  -- on-screen text/captions). Shape is owned by the analyze module, not the DB.
  visual_breakdown jsonb,
  -- The spoken hook (words in the opening seconds).
  hook_spoken text,
  -- The visual hook (what's on screen first / what grabs the eye).
  hook_visual text,
  -- Which BYO backend produced this row (e.g. 'gemini'). Attributable history.
  provider text,
  -- The exact model the workspace chose (e.g. 'gemini-2.5-flash').
  model text,
  -- When this analysis pass ran.
  analyzed_at timestamptz not null default now(),
  -- Verbatim provider response, kept for re-parsing without a re-charge.
  raw jsonb,
  created_at timestamptz not null default now()
);

-- Roll-up / list reads filter by workspace.
create index if not exists video_analysis_workspace_idx
  on public.video_analysis(workspace_id);
-- Per-post lookup ("does this post already have a breakdown?"). UNIQUE so a
-- re-run UPSERTs the single row per post rather than accreting duplicates.
create unique index if not exists video_analysis_post_idx
  on public.video_analysis(post_id);

-- ─────────────────────────────────────────────────────────────
-- RLS — workspace-scoped, mirrors the established member-gated pattern
-- (see post_outcomes in 042 + posts in 001_init.sql). Members of the owning
-- workspace read/write their own rows; the service role bypasses RLS (the
-- analyze server action runs service-role to decrypt the BYO key + read bytes).
-- A hook breakdown is normal user-facing CRUD (like outcomes), so members get
-- full read/write — not the service-role-only write avatars use.
-- ─────────────────────────────────────────────────────────────
alter table public.video_analysis enable row level security;

create policy "video_analysis: members read own workspace"
  on public.video_analysis for select
  using (public.is_workspace_member(workspace_id));

create policy "video_analysis: members write own workspace"
  on public.video_analysis for all
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
