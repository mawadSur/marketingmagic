-- marketingmagic · 016 — Fix infinite-recursion between workspaces ↔ memberships RLS
--
-- Symptom: SELECT on `public.workspaces` returns
--   "infinite recursion detected in policy for relation \"workspaces\""
-- which silently bricks the create-workspace flow (the form looks like it
-- accepts input, but `listWorkspaces()` returns 0 rows after insert, so the
-- onboarding wizard bounces back to the same screen).
--
-- Root cause: migrations 001 + 010 left two policy chains that cite each
-- other inside their USING / WITH CHECK subqueries:
--
--   workspaces SELECT:
--     A) owner_id = auth.uid()                                  -- safe
--     B) EXISTS (SELECT FROM memberships WHERE workspace_id=id  -- recursive
--                  AND user_id = auth.uid())
--
--   memberships SELECT:
--     C) user_id = auth.uid()                                   -- safe
--     D) EXISTS (SELECT FROM workspaces WHERE id=workspace_id   -- recursive
--                  AND owner_id = auth.uid())
--
-- PERMISSIVE policies are OR'd, so the planner must evaluate both arms. B's
-- subquery fires memberships RLS, which fires workspaces RLS again via D,
-- and Postgres aborts before the user-facing query ever runs.
--
-- Fix: route the cross-table checks through SECURITY DEFINER helpers. They
-- run as the function owner (postgres) and skip RLS on the tables they touch,
-- breaking the cycle while preserving the same access rules.
--
-- Reversible: drops + recreates the four memberships + four invitations
-- policies plus the one workspaces SELECT-via-memberships policy. The
-- owner-only policies on workspaces (from 001) are NOT touched.

-- ─────────────────────────────────────────────────────────────
-- helpers
-- ─────────────────────────────────────────────────────────────
create or replace function public.user_is_member_of_workspace(ws_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.memberships m
    where m.workspace_id = ws_id and m.user_id = auth.uid()
  );
$$;

create or replace function public.user_owns_workspace(ws_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.workspaces w
    where w.id = ws_id and w.owner_id = auth.uid()
  );
$$;

-- Anon role shouldn't see them; authenticated executes the safe wrapper.
revoke all on function public.user_is_member_of_workspace(uuid) from public;
revoke all on function public.user_owns_workspace(uuid) from public;
grant execute on function public.user_is_member_of_workspace(uuid) to authenticated, service_role;
grant execute on function public.user_owns_workspace(uuid) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────
-- workspaces — rebuild the recursive "via memberships" SELECT
-- ─────────────────────────────────────────────────────────────
drop policy if exists "Members read their workspaces (via memberships)" on public.workspaces;

create policy "Members read their workspaces (via memberships)"
  on public.workspaces for select
  using (public.user_is_member_of_workspace(id));

-- ─────────────────────────────────────────────────────────────
-- memberships — rebuild every cross-table policy
-- ─────────────────────────────────────────────────────────────
drop policy if exists "Owners read workspace memberships" on public.memberships;
drop policy if exists "Owners insert memberships"          on public.memberships;
drop policy if exists "Owners update memberships"          on public.memberships;
drop policy if exists "Owners delete memberships"          on public.memberships;

create policy "Owners read workspace memberships"
  on public.memberships for select
  using (public.user_owns_workspace(workspace_id));

create policy "Owners insert memberships"
  on public.memberships for insert
  to authenticated
  with check (public.user_owns_workspace(workspace_id));

create policy "Owners update memberships"
  on public.memberships for update
  using (public.user_owns_workspace(workspace_id))
  with check (public.user_owns_workspace(workspace_id));

create policy "Owners delete memberships"
  on public.memberships for delete
  using (public.user_owns_workspace(workspace_id));

-- ─────────────────────────────────────────────────────────────
-- workspace_invitations — same cross-table pattern, same fix
-- ─────────────────────────────────────────────────────────────
drop policy if exists "Owners read workspace_invitations"   on public.workspace_invitations;
drop policy if exists "Owners insert workspace_invitations" on public.workspace_invitations;
drop policy if exists "Owners update workspace_invitations" on public.workspace_invitations;
drop policy if exists "Owners delete workspace_invitations" on public.workspace_invitations;

create policy "Owners read workspace_invitations"
  on public.workspace_invitations for select
  using (public.user_owns_workspace(workspace_id));

create policy "Owners insert workspace_invitations"
  on public.workspace_invitations for insert
  to authenticated
  with check (
    public.user_owns_workspace(workspace_id)
    and invited_by = auth.uid()
  );

create policy "Owners update workspace_invitations"
  on public.workspace_invitations for update
  using (public.user_owns_workspace(workspace_id))
  with check (public.user_owns_workspace(workspace_id));

create policy "Owners delete workspace_invitations"
  on public.workspace_invitations for delete
  using (public.user_owns_workspace(workspace_id));
