-- Weekly AI review cache. Generated on demand, then cached for ~7 days so
-- we don't burn Anthropic credits re-summarising the same data on every
-- dashboard load.

create table public.ai_reviews (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  window_days integer not null,
  summary text not null,
  themes_worked text[] not null default '{}',
  themes_struggled text[] not null default '{}',
  timing_suggestions text[] not null default '{}',
  next_actions text[] not null default '{}',
  raw jsonb,
  generated_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index ai_reviews_workspace_freshness_idx
  on public.ai_reviews(workspace_id, expires_at desc);

alter table public.ai_reviews enable row level security;

create policy "Members can read ai_reviews"
  on public.ai_reviews for select
  using (public.is_workspace_member(workspace_id));

create policy "Members can write ai_reviews"
  on public.ai_reviews for all
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
