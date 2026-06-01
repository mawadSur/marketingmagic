-- marketingmagic · 033 — Org white-label branding logo bucket + admin helper
--
-- Completes the white-label slice of the agency/org layer (migration 029).
-- Two things, sharing the same trust boundary (organization membership):
--
--   1. user_is_org_admin(org_id)  — owner OR an 'admin'-role org_membership.
--      'manager' members are NOT admins. Mirrors user_is_org_member but is the
--      tighter gate for privileged actions (add-client, branding writes). Same
--      SECURITY DEFINER pattern as the 029 helpers → no RLS recursion.
--
--   2. org-branding storage bucket — a DEDICATED, org-scoped bucket for the
--      white-label logo, replacing the prior reuse of the public `post-media`
--      bucket (which is keyed on workspace_id and whose mime allowlist excludes
--      SVG). RLS mirrors the media-bucket pattern from migration 003, but keys
--      the prefix on ORGANIZATION id and gates with org membership:
--
--         object path layout:  <organization_id>/logo-<ts>.<ext>
--         read/write/update/delete: caller must be an org member of <organization_id>
--
--      Unlike the 003 media bucket, branding objects now carry a real RLS
--      boundary instead of only ever being written via the RLS-bypassing
--      service role. The allowed_mime_types include image/svg+xml so an SVG
--      logo (validated in the upload action) is actually accepted by storage.
--
-- ADDITIVE + BACKWARD-COMPATIBLE: no existing object/policy is altered. The
-- prior post-media `org-branding/` objects (if any) keep their public URLs and
-- keep rendering; new uploads land in this bucket going forward.

-- ─────────────────────────────────────────────────────────────
-- user_is_org_admin — owner or 'admin' role (tight gate)
-- ─────────────────────────────────────────────────────────────
create or replace function public.user_is_org_admin(org_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.organizations o
    where o.id = org_id and o.owner_id = auth.uid()
  ) or exists (
    select 1 from public.org_memberships om
    where om.organization_id = org_id
      and om.user_id = auth.uid()
      and om.role = 'admin'
  );
$$;

revoke all on function public.user_is_org_admin(uuid) from public;
grant execute on function public.user_is_org_admin(uuid) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────
-- org-branding storage bucket
-- ─────────────────────────────────────────────────────────────
-- public=true so the logo URL can be embedded directly in the unauthenticated
-- client portal + report PDF (same posture as post-media). Object layout:
-- `<organization_id>/logo-<ts>.<ext>`. 2MB cap matches the upload-action limit.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'org-branding',
  'org-branding',
  true,
  2 * 1024 * 1024,  -- 2MB — a logo, not a hero image.
  array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']
)
on conflict (id) do nothing;

-- Org-scoped read. The first path segment is the organization_id; a caller may
-- only read branding objects for an org they're a member of.
create policy "org-branding: members read own org"
  on storage.objects for select
  using (
    bucket_id = 'org-branding'
    and public.user_is_org_member((split_part(name, '/', 1))::uuid)
  );

-- Org-scoped write/update/delete. (Admin-gating of WHICH staff may change
-- branding is enforced in the server action; at the storage layer any org
-- member of the prefix org is allowed, mirroring post-media's member-scoped
-- write. The dangerous cross-org case — writing under another org's prefix —
-- is blocked here.)
create policy "org-branding: members write own org"
  on storage.objects for insert
  with check (
    bucket_id = 'org-branding'
    and public.user_is_org_member((split_part(name, '/', 1))::uuid)
  );

create policy "org-branding: members update own org"
  on storage.objects for update
  using (
    bucket_id = 'org-branding'
    and public.user_is_org_member((split_part(name, '/', 1))::uuid)
  );

create policy "org-branding: members delete own org"
  on storage.objects for delete
  using (
    bucket_id = 'org-branding'
    and public.user_is_org_member((split_part(name, '/', 1))::uuid)
  );
