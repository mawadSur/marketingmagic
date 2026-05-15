-- marketingmagic · 019 — Quick Experiments (Phase 6B)
--
-- Sequential variants of a single parent post, scheduled across distinct time
-- slots (≥48h apart). NOT a randomized A/B — winner declaration is labelled
-- "directional, not statistically rigorous" everywhere it surfaces. The full
-- statistical option is Phase 6C (cross-workspace) which is deferred.
--
-- Two tables:
--
--   1. `experiments` — one row per "Run Quick Experiment" click. Tracks
--      parent_post_id (the post we're varying off), status, variant_count,
--      and winner_variant_id once evaluateExperiment() declares one. The
--      winner FK is left nullable + ON DELETE SET NULL so deleting a
--      variant post doesn't cascade-kill the parent experiment row.
--
--   2. `post_variants` — one row per generated variant. Holds the parent
--      experiment, the synthesised post (parent_post_id → posts.id, so the
--      variant inherits all the usual queue/scheduling machinery), and the
--      allocation_weight column (reserved — V1 always emits weight=1.0,
--      but a future randomization pass can flip these to fractional).
--      `metrics_snapshot` caches the engagement_rate observed at winner-
--      declaration time so the dashboard widget doesn't re-query metrics.
--
-- RLS: both tables guard on `is_workspace_member(workspace_id)`. The
-- post_variants table doesn't carry workspace_id directly — it's derived
-- via the parent experiment, so the policy joins through. We add a
-- workspace_id column anyway (denormalised) to keep the policy simple and
-- to support per-workspace indexes without joins.
--
-- No new env vars.

-- ─────────────────────────────────────────────────────────────
-- experiments
-- ─────────────────────────────────────────────────────────────
create table if not exists public.experiments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- The post we're running variants against. Required at creation time; ON
  -- DELETE CASCADE because if the parent is removed the experiment loses
  -- its baseline and shouldn't outlive it.
  parent_post_id uuid not null references public.posts(id) on delete cascade,
  -- Experiment lifecycle:
  --   active     — variants scheduled, waiting for ≥48h of metrics
  --   complete   — winner declared (or no-winner verdict reached)
  --   cancelled  — user revoked the variants before evaluation
  status text not null default 'active' check (status in (
    'active',
    'complete',
    'cancelled'
  )),
  -- How many variants this experiment spawned. Mirrors the count of
  -- post_variants rows; denormalised so dashboard queries don't need a
  -- count(*) on every render.
  variant_count int not null check (variant_count between 1 and 5),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  -- The variant that won, once evaluateExperiment() runs. NULL until then.
  -- ON DELETE SET NULL so removing the winning variant row (e.g. user
  -- revoked it post-hoc) doesn't cascade-delete the experiment record.
  winner_variant_id uuid
);

create index if not exists experiments_workspace_status_idx
  on public.experiments(workspace_id, status, created_at desc);
create index if not exists experiments_parent_post_idx
  on public.experiments(parent_post_id);

alter table public.experiments enable row level security;

create policy "Members can read experiments"
  on public.experiments for select
  using (public.is_workspace_member(workspace_id));

create policy "Members can write experiments"
  on public.experiments for all
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- ─────────────────────────────────────────────────────────────
-- post_variants
-- ─────────────────────────────────────────────────────────────
create table if not exists public.post_variants (
  id uuid primary key default gen_random_uuid(),
  experiment_id uuid not null references public.experiments(id) on delete cascade,
  -- The actual generated post sitting in `posts`. ON DELETE CASCADE so
  -- revoking a variant from the queue tears down its row here too — keeps
  -- the join clean for the winner evaluator.
  parent_post_id uuid not null references public.posts(id) on delete cascade,
  -- Workspace denormalisation — see header comment. Required for the RLS
  -- policy to avoid a join through experiments on every read.
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- Reserved for future randomized allocation. V1 always emits 1.0 (sequential
  -- — each variant posted in its own slot). When we ship cross-workspace
  -- randomization (Phase 6C) this becomes the per-arm probability weight.
  allocation_weight numeric not null default 1.0 check (allocation_weight > 0),
  -- Snapshot of when the variant actually posted (vs. scheduled_at on the
  -- underlying post). NULL until the dispatcher fires.
  posted_at timestamptz,
  -- Snapshot of engagement metrics at winner-declaration time. Cached so
  -- the dashboard widget can read the verdict without re-running the
  -- lift computation. Shape: { engagement_rate, impressions, engagement, sample_age_hours }.
  metrics_snapshot jsonb,
  created_at timestamptz not null default now()
);

create index if not exists post_variants_experiment_idx
  on public.post_variants(experiment_id);
create index if not exists post_variants_workspace_idx
  on public.post_variants(workspace_id);
-- Lookup for "given a post, what variant row does it belong to?" — used by
-- the queue UI to flag rows as belonging to an experiment.
create index if not exists post_variants_parent_post_idx
  on public.post_variants(parent_post_id);

alter table public.post_variants enable row level security;

create policy "Members can read post_variants"
  on public.post_variants for select
  using (public.is_workspace_member(workspace_id));

create policy "Members can write post_variants"
  on public.post_variants for all
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
