-- marketingmagic · 008 — "Why This Post Wins" playbook
--
-- Two adjacent concerns ship in the same migration because they share a
-- feature surface (the explainer cards) and a deploy beat:
--
--   1. posts.explainer (jsonb cache)
--      Per-post Claude-generated explanation. Cached *on the post row* so
--      the dashboard can render an explainer card without a second join and
--      we never re-call Claude for the same outlier. Why a column and not
--      a side table:
--        - 1:1 with posts.id; a side table would only add an extra join.
--        - Posts already carry similarly-shaped JSON (generation_metadata, media).
--        - Cheap to backfill / null out — just `update posts set explainer = null`.
--
--   2. playbook_patterns
--      User-curated table of "patterns I want future plans to lean into."
--      Populated by clicking "Save pattern" on a winner explainer card; read
--      by the plan generator (src/lib/plan/prompt.ts) as preferred patterns.
--      Separate from posts because:
--        - Lifespan ≠ post lifespan (patterns outlive their source post).
--        - Many-to-one against an explainer kind (theme/timing/opener/length/voice).
--        - Tiny: short rows, indexed by workspace_id for fast plan-time lookup.

-- ─────────────────────────────────────────────────────────────
-- posts.explainer (cache)
-- ─────────────────────────────────────────────────────────────
alter table public.posts
  add column if not exists explainer jsonb;

-- ─────────────────────────────────────────────────────────────
-- playbook_patterns
-- ─────────────────────────────────────────────────────────────
create table if not exists public.playbook_patterns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- Where the pattern came from (post -> explainer reason -> save).
  source_post_id uuid references public.posts(id) on delete set null,
  -- Free-form classification matching ExplainerReason.kind in
  -- src/lib/explain/schema.ts: theme | timing | voice | opener | length | other.
  -- Kept as text (not an enum) so we don't have to ship a migration every
  -- time we add a kind.
  pattern_kind text not null,
  -- Verbatim reason + structured fields (e.g. { hour: 10, weekday: 2 }).
  pattern_data jsonb not null,
  -- Plain text summary the user clicked "save" on — surfaced verbatim in
  -- the planner system prompt for transparency.
  summary text not null,
  saved_at timestamptz not null default now(),
  saved_by uuid references auth.users(id) on delete set null
);

create index if not exists playbook_patterns_workspace_idx
  on public.playbook_patterns(workspace_id, saved_at desc);

create index if not exists playbook_patterns_kind_idx
  on public.playbook_patterns(workspace_id, pattern_kind);

alter table public.playbook_patterns enable row level security;

create policy "Members can read playbook_patterns"
  on public.playbook_patterns for select
  using (public.is_workspace_member(workspace_id));

create policy "Members can write playbook_patterns"
  on public.playbook_patterns for all
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
