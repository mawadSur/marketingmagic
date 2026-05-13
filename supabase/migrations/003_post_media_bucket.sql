-- V1-image: Supabase Storage bucket for generated post media.
--
-- Layout: storage objects are written under `<workspace_id>/<post_id>/<filename>`.
-- RLS:
--   * Workspace members can read/write objects under their own workspace prefix.
--   * Service role bypasses RLS (used by the post-scheduled cron when reading
--     bytes to upload to X).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'post-media',
  'post-media',
  true,
  10 * 1024 * 1024,  -- 10MB cap. fal stills are <2MB; gives headroom for future
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

-- Workspace-scoped read.
create policy "post-media: members read own workspace"
  on storage.objects for select
  using (
    bucket_id = 'post-media'
    and public.is_workspace_member((split_part(name, '/', 1))::uuid)
  );

-- Workspace-scoped write.
create policy "post-media: members write own workspace"
  on storage.objects for insert
  with check (
    bucket_id = 'post-media'
    and public.is_workspace_member((split_part(name, '/', 1))::uuid)
  );

create policy "post-media: members update own workspace"
  on storage.objects for update
  using (
    bucket_id = 'post-media'
    and public.is_workspace_member((split_part(name, '/', 1))::uuid)
  );

create policy "post-media: members delete own workspace"
  on storage.objects for delete
  using (
    bucket_id = 'post-media'
    and public.is_workspace_member((split_part(name, '/', 1))::uuid)
  );
