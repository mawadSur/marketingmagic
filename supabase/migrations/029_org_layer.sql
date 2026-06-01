-- marketingmagic · 029 — Agency / Organization layer (Phase A foundations)
--
-- Turns the flat workspace-per-tenant model into a true multi-tenant agency
-- product: one ORGANIZATION (the agency) owning many client WORKSPACES, billed
-- once at the org level, with a tokenized client approval portal coming in a
-- later phase. See docs/agency-org-layer-design.md for the full design + the
-- four locked decisions.
--
-- ADDITIVE + BACKWARD-COMPATIBLE: a workspace with organization_id = NULL
-- behaves exactly as today. Solo users are completely unaffected — every
-- existing RLS check (owner_id / memberships) is preserved verbatim; the org
-- grant is only ever OR'd on top.
--
-- This migration ships four things that share the same trust boundary
-- (organization ownership / membership):
--
--   1. organizations          — the agency tenant + its Stripe subscription
--                               + white-label branding.
--   2. org_memberships         — agency staff (admin / manager) on an org.
--   3. workspaces.organization_id — nullable FK marking a workspace as a
--                               client sub-tenant of an org.
--   4. client_portal_tokens    — tokenized client portal grants (Phase D
--                               builds the actual /client/[token] surface;
--                               the table + RLS land here so the schema is
--                               stable for the portal coder).
--   5. approvals audit tweak   — user_id nullable + client_token_id, so a
--                               portal (no-auth) approve/reject can be recorded.
--
-- RLS BLAST RADIUS (highest-risk change): is_workspace_member(ws_id) is the
-- single helper every tenant table's policy routes through. We extend it to
-- ALSO return true when the caller is an org member of the workspace's
-- organization. Because the function is SECURITY DEFINER it runs as the
-- function owner and SKIPS RLS on the tables it reads, so adding the org
-- join here does NOT reintroduce the workspaces↔memberships recursion that
-- migration 016 fixed. The org grant is scoped strictly to
-- (workspace.organization_id = org_membership.organization_id) so there is
-- NO cross-org leakage: an agency member only ever gains access to client
-- workspaces under THEIR org.

create extension if not exists "pgcrypto";

-- ─────────────────────────────────────────────────────────────
-- organizations (= the agency tenant)
-- ─────────────────────────────────────────────────────────────
-- owner_id is the agency owner (the auth user who created the org). Billing
-- identifiers mirror the per-workspace billing columns from migration 005 but
-- live at the org level: locked decision #1 is one Stripe subscription per
-- org, priced per client workspace / seat (quantity sync lands in Phase C).
-- plan reuses the same vocabulary as workspaces.plan so the entitlement
-- resolver can fall back cleanly; 'agency' is the natural default for an org.
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null check (slug ~ '^[a-z0-9-]{2,40}$'),
  name text not null,
  owner_id uuid not null references auth.users(id) on delete restrict,
  -- White-label branding (locked decision #4): logo in Supabase storage +
  -- two brand colours. Applied to the client portal + report PDFs in later
  -- phases. NULL = fall back to default marketingmagic branding.
  logo_url text,
  color_primary text,
  color_accent text,
  -- Org-level Stripe billing (locked decision #1). subscription_status mirrors
  -- the workspaces column shape (free text, set verbatim from the webhook).
  stripe_customer_id text,
  stripe_subscription_id text,
  subscription_status text,
  -- plan/tier the org is on. Same enum vocabulary as workspaces.plan so the
  -- entitlement resolver can reuse tierFor(); defaults to 'agency' since an
  -- org only exists to manage multiple client workspaces.
  plan text not null default 'agency'
    check (plan in ('hobby', 'pro', 'agency', 'founder')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index organizations_owner_id_idx on public.organizations(owner_id);

create index organizations_stripe_customer_idx
  on public.organizations(stripe_customer_id)
  where stripe_customer_id is not null;

create trigger organizations_set_updated_at
  before update on public.organizations
  for each row execute function public.set_updated_at();

alter table public.organizations enable row level security;

-- ─────────────────────────────────────────────────────────────
-- org_memberships (agency staff on an org)
-- ─────────────────────────────────────────────────────────────
-- role: 'admin' (full org control incl. billing + members) vs 'manager'
-- (manages client workspaces but not org billing/membership). Mirrors the
-- (workspace_id, user_id) PK shape of public.memberships.
create table public.org_memberships (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('admin', 'manager')),
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create index org_memberships_user_idx on public.org_memberships(user_id);

alter table public.org_memberships enable row level security;

-- ─────────────────────────────────────────────────────────────
-- SECURITY DEFINER helpers for org access (mirror migration 016's pattern)
-- ─────────────────────────────────────────────────────────────
-- These run as the function owner and skip RLS on the tables they touch,
-- which is exactly what lets us reference org_memberships ↔ organizations
-- inside each other's policies without the planner looping.

-- Is the caller the OWNER of this org? (full control, incl. billing)
create or replace function public.user_owns_organization(org_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.organizations o
    where o.id = org_id and o.owner_id = auth.uid()
  );
$$;

-- Is the caller a MEMBER (admin/manager) of this org? Owner counts as a member
-- too — they may not have an explicit org_memberships row.
create or replace function public.user_is_org_member(org_id uuid)
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
    where om.organization_id = org_id and om.user_id = auth.uid()
  );
$$;

revoke all on function public.user_owns_organization(uuid) from public;
revoke all on function public.user_is_org_member(uuid) from public;
grant execute on function public.user_owns_organization(uuid) to authenticated, service_role;
grant execute on function public.user_is_org_member(uuid) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────
-- organizations — RLS policies
-- ─────────────────────────────────────────────────────────────
-- Any org member (owner / admin / manager) can read the org. Only the owner
-- updates branding + billing + deletes. Inserts are open to authenticated
-- users creating their own org (with check owner_id = auth.uid()), mirroring
-- the workspaces INSERT policy from 001.
create policy "Org members can read their organization"
  on public.organizations for select
  using (public.user_is_org_member(id));

create policy "Authenticated users can create organizations"
  on public.organizations for insert
  to authenticated
  with check (owner_id = auth.uid());

create policy "Owners can update their organization"
  on public.organizations for update
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy "Owners can delete their organization"
  on public.organizations for delete
  using (owner_id = auth.uid());

-- ─────────────────────────────────────────────────────────────
-- org_memberships — RLS policies (owner manages; members read)
-- ─────────────────────────────────────────────────────────────
-- A user can always read their own membership row (so they can resolve which
-- orgs they belong to). The owner can read every membership in their org and
-- is the only one who can add / change / remove members.
create policy "Users can read their own org memberships"
  on public.org_memberships for select
  using (user_id = auth.uid());

create policy "Owners read org memberships"
  on public.org_memberships for select
  using (public.user_owns_organization(organization_id));

create policy "Owners insert org memberships"
  on public.org_memberships for insert
  to authenticated
  with check (public.user_owns_organization(organization_id));

create policy "Owners update org memberships"
  on public.org_memberships for update
  using (public.user_owns_organization(organization_id))
  with check (public.user_owns_organization(organization_id));

create policy "Owners delete org memberships"
  on public.org_memberships for delete
  using (public.user_owns_organization(organization_id));

-- ─────────────────────────────────────────────────────────────
-- workspaces.organization_id — the client-workspace link
-- ─────────────────────────────────────────────────────────────
-- NULL = solo workspace (today's behaviour, unchanged). Non-null = client
-- workspace owned/managed under that org. ON DELETE SET NULL: deleting an org
-- detaches its client workspaces back to solo rather than cascading away the
-- client's content (safer default; the add-client flow re-attaches).
alter table public.workspaces
  add column if not exists organization_id uuid references public.organizations(id) on delete set null;

create index if not exists workspaces_organization_id_idx
  on public.workspaces(organization_id)
  where organization_id is not null;

-- workspaces SELECT for org staff. The owner-only + member (010) SELECT
-- policies stay untouched; this third permissive policy lets agency staff
-- read the client workspace ROW (needed to render the switcher + dashboard).
-- Scoped strictly to the workspace's own organization → no cross-org leak.
create policy "Org members read client workspaces"
  on public.workspaces for select
  using (
    organization_id is not null
    and public.user_is_org_member(organization_id)
  );

-- Org members may UPDATE the client workspace row (rename, settings). Owner /
-- member-via-memberships update paths from 001 are preserved; this is additive.
create policy "Org members update client workspaces"
  on public.workspaces for update
  using (
    organization_id is not null
    and public.user_is_org_member(organization_id)
  )
  with check (
    organization_id is not null
    and public.user_is_org_member(organization_id)
  );

-- ─────────────────────────────────────────────────────────────
-- is_workspace_member — EXTEND with the org-member grant (RLS blast radius)
-- ─────────────────────────────────────────────────────────────
-- This is THE helper every tenant table (brand_briefs, posts, social_accounts,
-- posting_plans, ...) routes its RLS through. We re-create it preserving the
-- two existing arms verbatim (owner_id, memberships) and OR on a third arm:
-- the caller is an org member of the workspace's organization. SECURITY
-- DEFINER → no RLS recursion. The join pins w.id = ws_id so the org grant
-- only ever applies to workspaces UNDER an org the caller belongs to:
-- cross-org isolation is guaranteed by the equality, not by trust.
create or replace function public.is_workspace_member(ws_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.workspaces w
    where w.id = ws_id and w.owner_id = auth.uid()
  ) or exists (
    select 1 from public.memberships m
    where m.workspace_id = ws_id and m.user_id = auth.uid()
  ) or exists (
    -- Agency-staff grant: caller is an org member of the org this workspace
    -- belongs to. organization_id IS NULL (solo workspace) makes the join
    -- find nothing → solo behaviour is byte-for-byte unchanged.
    select 1
    from public.workspaces w
    join public.org_memberships om on om.organization_id = w.organization_id
    where w.id = ws_id and om.user_id = auth.uid()
  ) or exists (
    -- Org OWNER grant: an org owner may not have an explicit org_memberships
    -- row, so check ownership of the workspace's org directly too.
    select 1
    from public.workspaces w
    join public.organizations o on o.id = w.organization_id
    where w.id = ws_id and o.owner_id = auth.uid()
  );
$$;

-- ─────────────────────────────────────────────────────────────
-- client_portal_tokens (tokenized client approval portal — Phase D)
-- ─────────────────────────────────────────────────────────────
-- One row per issued client portal link. token_hash stores a SHA-256 of the
-- raw token (never the raw token) so a DB leak can't be replayed. scopes
-- gates what the holder can do ('approve', 'view_reports'). expires_at +
-- revoked_at give short-lived, revocable grants. The portal data-access path
-- runs via the SERVICE ROLE (bypassing RLS) and must scope EVERY query to the
-- single workspace this row resolves to — that hardened DAL is the #1 security
-- surface and is built in Phase D. RLS here is for the org-staff management UI
-- only (issue / list / revoke tokens for client workspaces they manage).
create table public.client_portal_tokens (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  token_hash text not null unique,
  label text,
  scopes text[] not null default '{}',
  expires_at timestamptz,
  revoked_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index client_portal_tokens_workspace_idx
  on public.client_portal_tokens(workspace_id);

-- Active-token lookup: hash → workspace, skipping revoked rows. The portal
-- resolver still checks expires_at at read time.
create index client_portal_tokens_hash_idx
  on public.client_portal_tokens(token_hash)
  where revoked_at is null;

alter table public.client_portal_tokens enable row level security;

-- Members of the workspace (which now includes org staff, via the extended
-- is_workspace_member) can read / issue / revoke portal tokens for that
-- workspace. No raw token is ever stored, so SELECT exposing token_hash is
-- safe. The unauthenticated portal path does NOT use these policies — it
-- goes through the service role.
create policy "Members read portal tokens"
  on public.client_portal_tokens for select
  using (public.is_workspace_member(workspace_id));

create policy "Members insert portal tokens"
  on public.client_portal_tokens for insert
  to authenticated
  with check (
    public.is_workspace_member(workspace_id)
    and (created_by is null or created_by = auth.uid())
  );

create policy "Members update portal tokens"
  on public.client_portal_tokens for update
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

create policy "Members delete portal tokens"
  on public.client_portal_tokens for delete
  using (public.is_workspace_member(workspace_id));

-- ─────────────────────────────────────────────────────────────
-- approvals — make user_id nullable + add client_token_id (portal audit)
-- ─────────────────────────────────────────────────────────────
-- A client portal approve/reject has no auth.uid() user. We allow user_id to
-- be NULL and record which portal token performed the action via
-- client_token_id. Exactly one of (user_id, client_token_id) should be set;
-- enforced by a CHECK so the audit trail is never ambiguous. The portal
-- write path runs via the service role (RLS-bypassing), so no public INSERT
-- policy is added for the portal case — only the existing authenticated
-- member-insert policy (001) stays, and its `user_id = auth.uid()` check is
-- still satisfied for the in-app path.
alter table public.approvals
  alter column user_id drop not null;

alter table public.approvals
  add column if not exists client_token_id uuid references public.client_portal_tokens(id) on delete set null;

-- Audit integrity: an approval is attributed to EITHER an auth user OR a
-- portal token, never both, never neither.
alter table public.approvals
  add constraint approvals_actor_exactly_one
  check ((user_id is not null) <> (client_token_id is not null));

create index approvals_client_token_idx
  on public.approvals(client_token_id)
  where client_token_id is not null;
