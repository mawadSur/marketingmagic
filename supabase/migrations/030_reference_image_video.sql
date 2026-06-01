-- marketingmagic · 030 — Reference-image video (bet ④) · SPIKE
--
-- ⚠️ SPIKE / ISOLATED WORKTREE: this migration was authored on a spike branch.
-- The number 030 is provisional — the lead may renumber on merge. Nothing here
-- ships live; it is gated behind the REFERENCE_VIDEO_ENABLED feature flag at the
-- application layer (referenceVideoEnabled() in src/lib/env.ts).
--
-- This is the NEW image-conditioned / talking-avatar generation path, distinct
-- from the MPT Pexels-stitch pipeline in 026. Two things land here:
--
--   1. Storage bucket `reference-image` — holds the user's uploaded reference
--      photo under `<workspace_id>/<upload_id>/<file>`. Mirrors the RLS shape of
--      026 (post-media-video) / 003 (post-media): split_part(name,'/',1) →
--      workspace_id, workspace-member read/write, service-role bypass.
--
--   2. `video_jobs.reference_image_path` — a nullable column so a render job can
--      carry the chosen reference photo. v1 design (see the spike doc) reuses
--      video_jobs and discriminates on params.kind = 'reference_image'; this
--      column is an optional convenience for cheap lookups + cleanup. A dedicated
--      reference_video_jobs table was considered and rejected for the spike
--      (duplicates the whole status machine) — noted for the lead.
--
-- See docs/designs/reference-image-video-spike.md for the full design + the
-- still-open vendor decision (recommended provider: fal.ai image-to-video).

-- ─────────────────────────────────────────────────────────────
-- 1. Storage bucket: reference-image
-- ─────────────────────────────────────────────────────────────
-- Layout: `<workspace_id>/<upload_id>/<filename>`. A portrait photo, not a hero
-- video — 10MB cap, image mime types only. RLS mirrors post-media-video (026):
-- workspace members read/write their own prefix; service role bypasses RLS (the
-- orchestrator reads bytes / the public URL to hand to the provider).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'reference-image',
  'reference-image',
  true,
  10485760,  -- 10MB. A reference portrait; generous headroom over typical phone photos.
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

-- Workspace-scoped read.
create policy "reference-image: members read own workspace"
  on storage.objects for select
  using (
    bucket_id = 'reference-image'
    and public.is_workspace_member((split_part(name, '/', 1))::uuid)
  );

-- Workspace-scoped write.
create policy "reference-image: members write own workspace"
  on storage.objects for insert
  with check (
    bucket_id = 'reference-image'
    and public.is_workspace_member((split_part(name, '/', 1))::uuid)
  );

create policy "reference-image: members update own workspace"
  on storage.objects for update
  using (
    bucket_id = 'reference-image'
    and public.is_workspace_member((split_part(name, '/', 1))::uuid)
  );

create policy "reference-image: members delete own workspace"
  on storage.objects for delete
  using (
    bucket_id = 'reference-image'
    and public.is_workspace_member((split_part(name, '/', 1))::uuid)
  );

-- ─────────────────────────────────────────────────────────────
-- 2. video_jobs.reference_image_path
-- ─────────────────────────────────────────────────────────────
-- Nullable: existing MPT jobs (params.kind = 'mpt') leave it null. Reference
-- jobs set it to `<workspace_id>/<upload_id>/<file>` in the reference-image
-- bucket. Additive + nullable, so this is backward-compatible with every row in
-- 026's video_jobs.
alter table public.video_jobs
  add column if not exists reference_image_path text;
