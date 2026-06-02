-- marketingmagic · 037 — Client ACCOUNTS for the agency layer (bet ③)
--
-- Authenticated client users who LOG IN and see ONLY their own workspace's
-- read-only report. This is the account counterpart to the tokenized portal
-- (migration 029 client_portal_tokens + /client/[token]); both surfaces remain
-- live — the account path is purely ADDITIVE.
--
-- ─────────────────────────────────────────────────────────────
-- SECURITY MODEL (the whole point of this migration)
-- ─────────────────────────────────────────────────────────────
-- A "client user" is an auth user linked to one or more client workspaces via a
-- NARROW link table, client_memberships. This link is DELIBERATELY SEPARATE
-- from public.memberships (the full member path that grants post edit /
-- approvals / channel management). A client_membership grants exactly ONE
-- capability: read the aggregate REPORT for the linked workspace. Nothing else.
--
-- THE NON-NEGOTIABLE INVARIANT: client_memberships is NEVER referenced by
-- is_workspace_member() (the helper every tenant table — posts,
-- social_accounts, brand_briefs, … — routes its RLS through). We do NOT touch
-- is_workspace_member here. Therefore a client user is, to every existing tenant
-- RLS policy, an anonymous authenticated user with zero workspace access: they
-- cannot SELECT posts/social_accounts/brand_briefs/approvals, cannot see
-- organizations or org_memberships, and cannot see OTHER client workspaces.
--
-- The ONLY data a client can reach is the aggregate report, served by a
-- service-role DAL (src/lib/portal/account.ts) that gates EVERY read on an
-- explicit user_is_client_of(ws_id) check derived from auth.uid(). There is no
-- write path anywhere for a client.
--
-- Cross-tenant isolation is structural, not trust-based:
--   • RLS on client_memberships: a user SELECTs ONLY rows where
--     user_id = auth.uid(). They cannot even enumerate other users' links.
--   • user_is_client_of(ws_id) is SECURITY DEFINER and derives the workspace
--     set from auth.uid() — the caller passes a ws_id and gets a yes/no for
--     THEMSELVES only; they can never assert membership of a workspace they
--     aren't linked to (no spoofing).
--   • Inserts are service-role only (no authenticated INSERT/UPDATE/DELETE
--     policy), so a client can never self-link to a workspace.

-- ─────────────────────────────────────────────────────────────
-- client_memberships — the narrow client↔workspace link
-- ─────────────────────────────────────────────────────────────
-- One row per (client user, client workspace). ON DELETE CASCADE on both FKs so
-- deleting the user OR the workspace cleans the link up. unique(user_id,
-- workspace_id) makes the membership idempotent — the signup hook can upsert
-- without creating duplicates.
create table public.client_memberships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, workspace_id)
);

create index client_memberships_user_idx on public.client_memberships(user_id);
create index client_memberships_workspace_idx on public.client_memberships(workspace_id);

alter table public.client_memberships enable row level security;

-- ─────────────────────────────────────────────────────────────
-- user_is_client_of — SECURITY DEFINER helper (mirrors 029/033 helpers)
-- ─────────────────────────────────────────────────────────────
-- "Is the CALLER a client of this workspace?" Derived strictly from auth.uid():
-- the caller supplies a ws_id and learns a boolean about THEMSELVES only. There
-- is no parameter for a user id, so a caller can never ask "is user X a client
-- of workspace Y" — the only subject is always auth.uid(). SECURITY DEFINER so
-- the DAL can call it under any context; STABLE; search_path pinned;
-- revoke-from-public then grant to authenticated + service_role, exactly like
-- user_is_org_member (029) and user_is_org_admin (033).
--
-- IMPORTANT: this helper is consumed ONLY by the report DAL's explicit gate and
-- (optionally) by the SELECT policy below. It is intentionally NOT wired into
-- is_workspace_member — a client must never gain member rights.
create or replace function public.user_is_client_of(ws_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.client_memberships cm
    where cm.workspace_id = ws_id and cm.user_id = auth.uid()
  );
$$;

revoke all on function public.user_is_client_of(uuid) from public;
grant execute on function public.user_is_client_of(uuid) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────
-- client_memberships — RLS policies
-- ─────────────────────────────────────────────────────────────
-- SELECT: a user reads ONLY their own link rows. This lets the app resolve
-- "which workspaces is this client invited to" (the workspace picker) without
-- ever exposing another client's links or any workspace they aren't linked to.
create policy "Users read their own client memberships"
  on public.client_memberships for select
  using (user_id = auth.uid());

-- NO insert / update / delete policy for authenticated users on purpose. With
-- RLS enabled and no permissive write policy, every client write is denied. The
-- ONLY writer is the service role (signup hook + agency invite), which bypasses
-- RLS by design. A client therefore can never self-link, re-target, or remove a
-- membership to widen or alter their scope.
