-- marketingmagic · 040 — Facebook Group Assist (ToS-safe, human-in-the-loop)
--
-- WHY THIS IS A SEPARATE MODULE, NOT A NEW "CHANNEL":
-- Meta shut down the Groups API (publish_to_groups + the Group node + the
-- group /feed endpoint were removed on 2024-04-22). There is NO supported way
-- for a third-party app to programmatically post to — or join — a Facebook
-- Group. So "post to a group" can only ever be a HUMAN action: we draft the
-- copy, the operator pastes & posts it themselves.
--
-- That single fact drives the schema. The live publish path (`posts` →
-- post-scheduled cron → dispatchPost switch) AUTO-SENDS anything with
-- status='scheduled'. If group drafts lived in `posts` we'd be one bug away
-- from a group draft being dispatched to a real Page (or throwing on an
-- unknown channel) on the most safety-critical code path in the app. So group
-- drafts live in their OWN tables and never touch the cron/dispatcher. Nothing
-- here is ever auto-published.
--
-- Two tables:
--   facebook_groups       — the groups a workspace cares about (name + link +
--                           the group's own posting RULES so we can warn the
--                           operator when it's a bad time / wrong kind of post)
--   facebook_group_drafts — copy tailored to a group, in a tiny lifecycle
--                           (draft → posted | dismissed). The operator copies
--                           the text, opens the group, posts, then marks it.

-- ─────────────────────────────────────────────────────────────
-- facebook_groups — a workspace's tracked Facebook Groups
-- ─────────────────────────────────────────────────────────────
create table if not exists public.facebook_groups (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- Human label shown in the picker ("SaaS Founders", "Local Makers", …).
  name text not null,
  -- The group's URL (https://www.facebook.com/groups/<id-or-vanity>). We open
  -- this in a new tab when the operator clicks "Copy & open group". Validated
  -- at the app layer; stored as plain text so we don't reject odd vanity URLs.
  url text not null,
  -- Optional rough size, for the operator's own context. Free-form integer.
  member_count integer,
  -- ── Posting RULES (the "heads-up" engine) ──────────────────────────────
  -- Many groups have strict self-promo rules ("promo Fridays only", "no
  -- links", "value posts only"). We capture enough structure to warn the
  -- operator BEFORE they post, and to steer the AI copy generator.
  --
  -- promo_policy: how this group tolerates promotional posts.
  --   'open'      — promo is fine any day
  --   'limited'   — promo only on specific weekdays (see promo_weekdays)
  --   'value_only'— never straight promo; lead with value, soft mention at most
  promo_policy text not null default 'open'
    check (promo_policy in ('open', 'limited', 'value_only')),
  -- ISO weekdays (1=Mon … 7=Sun) on which promo is allowed. Only meaningful
  -- when promo_policy='limited'. Empty = no day restriction recorded.
  promo_weekdays smallint[] not null default '{}',
  -- Whether the group bans links in posts (very common). Surfaced as a warning
  -- and passed to the generator so it avoids URLs / suggests "link in comments".
  allow_links boolean not null default true,
  -- Free-form rules text pasted from the group's pinned "rules" post. Fed to
  -- the AI generator verbatim so copy respects the group's specific norms.
  rules_notes text not null default '',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists facebook_groups_workspace_idx
  on public.facebook_groups(workspace_id);

create trigger facebook_groups_set_updated_at
  before update on public.facebook_groups
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────
-- facebook_group_drafts — copy tailored to a specific group
-- ─────────────────────────────────────────────────────────────
create table if not exists public.facebook_group_drafts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  group_id uuid not null references public.facebook_groups(id) on delete cascade,
  -- The copy the operator will paste into the group.
  text text not null,
  -- 'ai' (generated from brief + voice + group rules) or 'manual' (typed).
  source text not null default 'manual' check (source in ('ai', 'manual')),
  -- Tiny lifecycle. Deliberately NOT the `posts` status enum — these never go
  -- through the publish pipeline.
  --   'draft'     — ready for the operator to copy & post
  --   'posted'    — operator confirmed they posted it (audit + dedupe)
  --   'dismissed' — operator discarded it
  status text not null default 'draft'
    check (status in ('draft', 'posted', 'dismissed')),
  -- Set when status flips to 'posted'. The operator self-reports this; it's an
  -- honest log, not a platform confirmation (we have no API to confirm).
  posted_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists facebook_group_drafts_group_idx
  on public.facebook_group_drafts(group_id, status);
create index if not exists facebook_group_drafts_workspace_idx
  on public.facebook_group_drafts(workspace_id, status);

create trigger facebook_group_drafts_set_updated_at
  before update on public.facebook_group_drafts
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────
-- RLS — workspace-scoped, mirrors the established member-gated pattern
-- (see avatars / posts in 001_init.sql + 039). Members of the owning
-- workspace read/write their own rows; service role bypasses RLS.
-- Unlike avatars (service-role-only writes), group management is a normal
-- user CRUD surface, so members get full read/write like `posts`.
-- ─────────────────────────────────────────────────────────────
alter table public.facebook_groups enable row level security;

create policy "facebook_groups: members read own workspace"
  on public.facebook_groups for select
  using (public.is_workspace_member(workspace_id));

create policy "facebook_groups: members write own workspace"
  on public.facebook_groups for all
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

alter table public.facebook_group_drafts enable row level security;

create policy "facebook_group_drafts: members read own workspace"
  on public.facebook_group_drafts for select
  using (public.is_workspace_member(workspace_id));

create policy "facebook_group_drafts: members write own workspace"
  on public.facebook_group_drafts for all
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
