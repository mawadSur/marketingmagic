-- marketingmagic · 055 — Facebook Group DISCOVERY (AI suggestions, ToS-safe)
--
-- WHAT THIS IS:
-- The existing Group Assist (migrations 040/041) helps an operator DRAFT and
-- TIME posts for groups they're ALREADY in. This adds the step before that:
-- helping them FIND which Facebook Groups are worth joining to market their
-- product — turning the brand brief (product, audience, niche, voice) into a
-- shortlist of relevant group archetypes, each with a Facebook group-SEARCH
-- link the operator clicks to find + apply/join MANUALLY.
--
-- WHY THESE ARE *SUGGESTIONS*, NOT VERIFIED GROUPS:
-- Meta removed the Groups API on 2024-04-22 — there is NO supported way for a
-- third-party app to search, read, join, or post to a Facebook Group. So we
-- CANNOT enumerate real groups or confirm one exists. What we CAN do honestly:
--   1. Ask the model for relevant group ARCHETYPES (topic + why it fits THIS
--      product + a good search query), and
--   2. Hand the operator an outbound facebook.com/search/groups/?q=… link they
--      click to do the finding + the (manual) join on Facebook itself.
-- Nothing here scrapes Facebook or automates joining. The row is a saved
-- AI suggestion + a link. This mirrors the rest of Group Assist: human-in-the-
-- loop, and DELIBERATELY isolated from the `posts` auto-publish pipeline.
--
-- Persisting suggestions (rather than regenerating each visit) lets the
-- operator triage over time: save the promising ones, mark which they applied
-- to / joined, and dismiss the rest — a durable "groups to grow in" shortlist.

-- ─────────────────────────────────────────────────────────────
-- discovered_groups — AI-suggested Facebook Group archetypes to join
-- ─────────────────────────────────────────────────────────────
create table if not exists public.discovered_groups (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- Human-readable group name/topic the model proposes ("Indie SaaS Founders",
  -- "Local Wedding Photographers", …). NOT a real group's exact name — it's the
  -- KIND of group to look for. Framed as a suggestion everywhere in the UI.
  name text not null,
  -- One-line description of what this kind of group is / who's in it.
  description text not null default '',
  -- WHY this group fits THIS product/service — the model's relevance rationale,
  -- grounded in the brand brief. This is the column that makes a suggestion
  -- trustworthy ("your audience of bootstrapped founders gathers here").
  why_relevant text not null default '',
  -- Optional rough audience size, when the model can estimate one. Nullable —
  -- we have no API to verify membership counts, so this is a hint, never a fact.
  approx_members integer check (approx_members is null or approx_members >= 0),
  -- The topic/niche bucket this suggestion belongs to (e.g. "SaaS", "Local",
  -- "Parenting"). Lets the UI group the shortlist and keeps suggestions diverse.
  topic text not null default '',
  -- The outbound Facebook group-SEARCH URL the operator clicks to find the real
  -- group(s) and apply/join by hand. Always a facebook.com/search/groups/?q=…
  -- link (built + validated at the app layer in lib/groups/discover.ts).
  facebook_search_url text not null,
  -- The raw query we encoded into facebook_search_url, kept separately so the UI
  -- can show "search Facebook for: <query>" and the operator can tweak it.
  suggested_search_query text not null default '',
  -- Triage lifecycle. Deliberately NOT the `posts` status enum — these never go
  -- through the publish pipeline (Meta has no Groups API to publish/join with).
  --   'suggested' — freshly generated, awaiting the operator's triage (default)
  --   'saved'     — operator wants to pursue this one (kept on the shortlist)
  --   'applied'   — operator clicked through and requested to join a real group
  --   'joined'    — operator self-reports they were accepted into a group
  --   'dismissed' — not relevant; hidden from the active shortlist
  status text not null default 'suggested'
    check (status in ('suggested', 'saved', 'applied', 'joined', 'dismissed')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists discovered_groups_workspace_idx
  on public.discovered_groups(workspace_id, status);

-- Dedupe guard: don't persist the same suggested search query twice for a
-- workspace. The app lower-cases + trims the query before insert, so a
-- functional unique index on the normalized form catches re-runs that surface
-- an identical archetype. Partial on a non-empty query so blank legacy rows
-- (shouldn't happen — query is generated) never collide.
create unique index if not exists discovered_groups_workspace_query_uniq
  on public.discovered_groups(workspace_id, lower(suggested_search_query))
  where suggested_search_query <> '';

create trigger discovered_groups_set_updated_at
  before update on public.discovered_groups
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────
-- RLS — workspace-scoped, mirrors facebook_groups (migration 040):
-- members of the owning workspace read/write their own rows; the service role
-- bypasses RLS. Discovery is a normal user CRUD surface, so members get full
-- read/write like the groups table.
-- ─────────────────────────────────────────────────────────────
alter table public.discovered_groups enable row level security;

create policy "discovered_groups: members read own workspace"
  on public.discovered_groups for select
  using (public.is_workspace_member(workspace_id));

create policy "discovered_groups: members write own workspace"
  on public.discovered_groups for all
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
