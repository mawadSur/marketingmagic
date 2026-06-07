-- marketingmagic · 042 — post outcomes (self-reported outcome tagging)
--
-- THE KEYSTONE OF THE OUTCOME LOOP (Bet 1).
-- The learning loop today ranks themes by ENGAGEMENT (impressions, likes,
-- replies) — a proxy. This table lets a user attach a self-reported BUSINESS
-- OUTCOME (a lead, a sale, a signup, a booking) to a post that's already gone
-- live, optionally with a dollar amount. Once outcomes accrue, the analytics
-- surface can rank themes by REVENUE / outcome count, not just clicks — the
-- whole point of the loop.
--
-- SCOPE: self-report MVP only. There is no UTM / short-link / pixel ingestion
-- here — that's a deferred phase 2. A row in this table is a human assertion
-- ("this post drove a sale"), entered through the analytics "Mark outcome"
-- affordance. We trust it the same way we trust facebook_group_drafts.posted_at:
-- an honest operator log, not a platform-confirmed fact.
--
-- One post can have MANY outcomes (a post might drive several leads over time),
-- so this is a child table of `posts`, not a column on it.

-- ─────────────────────────────────────────────────────────────
-- post_outcomes — self-reported business outcomes attributed to a post
-- ─────────────────────────────────────────────────────────────
create table if not exists public.post_outcomes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- The live post this outcome is attributed to. ON DELETE CASCADE: if the
  -- post is hard-deleted, its outcomes go with it (they're meaningless without
  -- the post + its theme).
  post_id uuid not null references public.posts(id) on delete cascade,
  -- What kind of outcome the user is reporting. Closed vocabulary so the
  -- analytics roll-up stays comparable across workspaces. 'other' is the
  -- catch-all (use `note` to explain).
  outcome_type text not null
    check (outcome_type in ('lead', 'sale', 'signup', 'booking', 'other')),
  -- Revenue in CENTS, when known. Nullable — a 'lead' or 'signup' often has no
  -- dollar value attached; a 'sale' usually does. Integer cents (not float
  -- dollars) so the per-theme SUM is exact.
  value_cents integer,
  -- Optional free-form context ("closed via the demo link", "annual plan").
  note text,
  -- The member who recorded the outcome. Nullable + ON DELETE SET NULL so a
  -- removed member doesn't orphan-cascade their outcome history.
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Roll-up reads filter by workspace; the analytics join walks workspace → posts.
create index if not exists post_outcomes_workspace_idx
  on public.post_outcomes(workspace_id);
-- Per-post lookups (e.g. "how many outcomes does this post already have").
create index if not exists post_outcomes_post_idx
  on public.post_outcomes(post_id);

-- ─────────────────────────────────────────────────────────────
-- RLS — workspace-scoped, mirrors the established member-gated pattern
-- (see posts in 001_init.sql + facebook_group_drafts in 040). Members of the
-- owning workspace read/write their own rows; the service role bypasses RLS.
-- Outcome tagging is a normal user CRUD surface (like posts / groups), so
-- members get full read/write — not the service-role-only write avatars use.
-- ─────────────────────────────────────────────────────────────
alter table public.post_outcomes enable row level security;

create policy "post_outcomes: members read own workspace"
  on public.post_outcomes for select
  using (public.is_workspace_member(workspace_id));

create policy "post_outcomes: members write own workspace"
  on public.post_outcomes for all
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
