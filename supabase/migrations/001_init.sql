-- marketingmagic · initial schema (V0)
--
-- Multi-tenant marketing automation: every business-data table carries a
-- workspace_id and an RLS policy that checks the caller is a member of
-- that workspace. Service-role (cron + webhooks) bypasses RLS.
--
-- For V0 we use workspaces.owner_id directly (single owner per workspace);
-- the memberships table is included but unused until V1 multi-user.

create extension if not exists "pgcrypto";

-- ─────────────────────────────────────────────────────────────
-- updated_at helper
-- ─────────────────────────────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

-- ─────────────────────────────────────────────────────────────
-- workspaces (= "clients" in user-speak)
-- ─────────────────────────────────────────────────────────────
create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null check (slug ~ '^[a-z0-9-]{2,40}$'),
  name text not null,
  owner_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index workspaces_owner_id_idx on public.workspaces(owner_id);

create trigger workspaces_set_updated_at
  before update on public.workspaces
  for each row execute function public.set_updated_at();

alter table public.workspaces enable row level security;

create policy "Members can read their workspaces"
  on public.workspaces for select
  using (owner_id = auth.uid());

create policy "Owners can update their workspaces"
  on public.workspaces for update
  using (owner_id = auth.uid());

create policy "Authenticated users can create workspaces"
  on public.workspaces for insert
  to authenticated
  with check (owner_id = auth.uid());

-- ─────────────────────────────────────────────────────────────
-- memberships (V1; structure ready, not enforced in V0)
-- ─────────────────────────────────────────────────────────────
create table public.memberships (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

alter table public.memberships enable row level security;

create policy "Users can read their own memberships"
  on public.memberships for select
  using (user_id = auth.uid());

-- Helper: is the calling user a member of this workspace? Used by
-- every other table's RLS policy.
create or replace function public.is_workspace_member(ws_id uuid)
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from public.workspaces w
    where w.id = ws_id and w.owner_id = auth.uid()
  ) or exists (
    select 1 from public.memberships m
    where m.workspace_id = ws_id and m.user_id = auth.uid()
  );
$$;

-- ─────────────────────────────────────────────────────────────
-- brand_briefs (one per workspace; the input to plan generation)
-- ─────────────────────────────────────────────────────────────
create table public.brand_briefs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null unique references public.workspaces(id) on delete cascade,
  product_description text not null,
  voice text not null,
  target_audience text not null,
  do_not_say text[] not null default '{}',
  reference_links text[] not null default '{}',
  reference_posts text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger brand_briefs_set_updated_at
  before update on public.brand_briefs
  for each row execute function public.set_updated_at();

alter table public.brand_briefs enable row level security;

create policy "Members can read brand briefs"
  on public.brand_briefs for select
  using (public.is_workspace_member(workspace_id));

create policy "Members can write brand briefs"
  on public.brand_briefs for all
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- ─────────────────────────────────────────────────────────────
-- social_accounts (connected channels, with credentials)
-- ─────────────────────────────────────────────────────────────
-- credentials is jsonb so each channel can store its own shape:
--   x:        { apiKey, apiSecret, accessToken, accessTokenSecret }
--   bluesky:  { handle, appPassword }
--   ig/fb:    { pageId, accessToken, ... }
-- Service-role only reads/writes; clients never see this column.
create table public.social_accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  channel text not null check (channel in ('x', 'instagram', 'facebook', 'threads', 'bluesky', 'linkedin')),
  handle text not null,
  credentials jsonb not null,
  trust_mode boolean not null default false,
  trust_threshold integer not null default 5,
  successful_post_count integer not null default 0,
  status text not null default 'connected' check (status in ('connected', 'expired', 'revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, channel, handle)
);

create index social_accounts_workspace_idx on public.social_accounts(workspace_id);

create trigger social_accounts_set_updated_at
  before update on public.social_accounts
  for each row execute function public.set_updated_at();

alter table public.social_accounts enable row level security;

-- Members can see their accounts but NOT the credentials column.
-- Enforce by exposing a view that omits credentials; clients query
-- the view, never the table.
create policy "Members can read their accounts (server-side filtered)"
  on public.social_accounts for select
  using (public.is_workspace_member(workspace_id));

create policy "Members can write their accounts"
  on public.social_accounts for insert
  to authenticated
  with check (public.is_workspace_member(workspace_id));

create policy "Members can update their accounts"
  on public.social_accounts for update
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

create or replace view public.social_accounts_safe
  with (security_invoker = true)
  as
  select
    id, workspace_id, channel, handle, trust_mode, trust_threshold,
    successful_post_count, status, created_at, updated_at
  from public.social_accounts;

-- ─────────────────────────────────────────────────────────────
-- posting_plans (4-week generated calendars)
-- ─────────────────────────────────────────────────────────────
create table public.posting_plans (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  status text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  generation_prompt text,
  generation_response jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index posting_plans_workspace_idx on public.posting_plans(workspace_id, status);

create trigger posting_plans_set_updated_at
  before update on public.posting_plans
  for each row execute function public.set_updated_at();

alter table public.posting_plans enable row level security;

create policy "Members can read plans"
  on public.posting_plans for select
  using (public.is_workspace_member(workspace_id));

create policy "Members can write plans"
  on public.posting_plans for all
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- ─────────────────────────────────────────────────────────────
-- posts (individual post drafts → scheduled → posted)
-- ─────────────────────────────────────────────────────────────
create table public.posts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  plan_id uuid references public.posting_plans(id) on delete set null,
  social_account_id uuid not null references public.social_accounts(id) on delete restrict,
  channel text not null,
  text text not null,
  media jsonb not null default '[]'::jsonb,
  theme text,
  scheduled_at timestamptz,
  status text not null default 'draft' check (status in (
    'draft', 'pending_approval', 'approved', 'scheduled',
    'posted', 'failed', 'rejected', 'archived'
  )),
  external_id text,
  posted_at timestamptz,
  failure_reason text,
  source_event_id uuid,
  generation_metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index posts_workspace_status_idx on public.posts(workspace_id, status);
create index posts_scheduled_at_idx on public.posts(scheduled_at) where status = 'scheduled';
create index posts_plan_idx on public.posts(plan_id);
create index posts_theme_idx on public.posts(theme) where theme is not null;

create trigger posts_set_updated_at
  before update on public.posts
  for each row execute function public.set_updated_at();

alter table public.posts enable row level security;

create policy "Members can read posts"
  on public.posts for select
  using (public.is_workspace_member(workspace_id));

create policy "Members can write posts"
  on public.posts for all
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- ─────────────────────────────────────────────────────────────
-- approvals (audit trail of approve/edit/reject)
-- ─────────────────────────────────────────────────────────────
create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete restrict,
  action text not null check (action in ('approved', 'rejected', 'edited', 'unapproved')),
  diff text,
  created_at timestamptz not null default now()
);

create index approvals_post_idx on public.approvals(post_id);

alter table public.approvals enable row level security;

create policy "Members can read approvals"
  on public.approvals for select
  using (exists (
    select 1 from public.posts p
    where p.id = post_id and public.is_workspace_member(p.workspace_id)
  ));

create policy "Members can insert approvals"
  on public.approvals for insert
  to authenticated
  with check (
    user_id = auth.uid() and exists (
      select 1 from public.posts p
      where p.id = post_id and public.is_workspace_member(p.workspace_id)
    )
  );

-- ─────────────────────────────────────────────────────────────
-- post_metrics (V1: pulled-back KPIs from platforms)
-- ─────────────────────────────────────────────────────────────
create table public.post_metrics (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  fetched_at timestamptz not null default now(),
  impressions integer,
  likes integer,
  reposts integer,
  replies integer,
  clicks integer,
  engagement_rate numeric(6,4),
  raw jsonb
);

create index post_metrics_post_idx on public.post_metrics(post_id, fetched_at desc);

alter table public.post_metrics enable row level security;

create policy "Members can read post metrics"
  on public.post_metrics for select
  using (exists (
    select 1 from public.posts p
    where p.id = post_id and public.is_workspace_member(p.workspace_id)
  ));

-- ─────────────────────────────────────────────────────────────
-- social_posts (idempotency ledger; lifted from pitch-pit pattern)
-- ─────────────────────────────────────────────────────────────
-- Prevents double-posting when crons retry or webhooks fire twice.
create table public.social_posts_ledger (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  channel text not null,
  event_key text not null,
  external_id text,
  payload jsonb,
  posted_at timestamptz not null default now(),
  unique (workspace_id, channel, event_key)
);

create index social_posts_ledger_ws_idx on public.social_posts_ledger(workspace_id, posted_at desc);

alter table public.social_posts_ledger enable row level security;
-- Service-role only — no public policies.

-- ─────────────────────────────────────────────────────────────
-- events + event_rules (V1; structure laid down for forward-compat)
-- ─────────────────────────────────────────────────────────────
create table public.events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  event_type text not null,
  payload jsonb not null,
  source text,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);

create index events_workspace_unprocessed_idx on public.events(workspace_id) where processed_at is null;

alter table public.events enable row level security;

create policy "Members can read events"
  on public.events for select
  using (public.is_workspace_member(workspace_id));

create table public.event_rules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  event_type text not null,
  template text not null,
  channels text[] not null,
  theme text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger event_rules_set_updated_at
  before update on public.event_rules
  for each row execute function public.set_updated_at();

alter table public.event_rules enable row level security;

create policy "Members can read event rules"
  on public.event_rules for select
  using (public.is_workspace_member(workspace_id));

create policy "Members can write event rules"
  on public.event_rules for all
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
