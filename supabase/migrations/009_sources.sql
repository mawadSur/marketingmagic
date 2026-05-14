-- marketingmagic · 009 — Source-to-Posts Ingestion (Phase 2.5)
--
-- Customer pastes a URL or uploads a file → we extract themes, quotes, and
-- facts via Claude → generate a content cluster anchored to that source.
-- Every post the cluster spawns stores `source_id` so engagement metrics can
-- be rolled up to "which sources produced the highest-performing posts."
--
-- Two schema concerns in this migration:
--
--   1. `sources` — the ingested artifact itself: URL or uploaded file, the
--      extracted summary, and the structured themes/quotes/facts JSON that
--      the planner reads when generating posts.
--
--   2. `posts.source_id` — nullable FK pointing at the source that anchored
--      the cluster. NULL for posts that weren't generated from a source.
--      `on delete set null` so deleting a source doesn't cascade into the
--      audit trail of posts already shipped.
--
-- Env vars introduced (also documented in src/lib/env.ts and
-- .env.local.example):
--   GROQ_API_KEY — optional. Powers hosted Whisper for YouTube/podcast/MP3
--                  sources. When unset the audio/video paths short-circuit
--                  with a "transcription unavailable" message; HTML/PDF/
--                  paste-transcript paths still work. Get a free key at
--                  https://console.groq.com/keys.

-- ─────────────────────────────────────────────────────────────
-- sources
-- ─────────────────────────────────────────────────────────────
create table if not exists public.sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- Discriminator. `transcript` covers user-pasted text (audio caption pastes,
  -- meeting notes, raw notes) so we don't need a separate "freeform" kind.
  source_kind text not null check (source_kind in ('html', 'youtube', 'podcast', 'pdf', 'transcript')),
  -- One of source_url / file_path is typically set; both nullable so a
  -- `transcript` kind can carry just inline text via extracted_summary +
  -- title. We don't enforce a CHECK constraint because the UI gates this.
  source_url text,
  file_path text,
  title text,
  -- Verbatim Claude-extracted prose summary. Surfaced in the source detail
  -- view and fed back into the planner as "## Source material".
  extracted_summary text,
  -- Structured arrays. `quotes` are verbatim pulls the planner can lean on
  -- as hooks; `themes` are free-form tags the planner can match against the
  -- workspace's existing theme-leaderboard signal; `facts` are concrete
  -- claims the planner can build copy around without inventing numbers.
  extracted_quotes jsonb not null default '[]'::jsonb,
  extracted_themes jsonb not null default '[]'::jsonb,
  extracted_facts jsonb not null default '[]'::jsonb,
  ingested_by uuid references auth.users(id) on delete set null,
  ingested_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists sources_workspace_idx
  on public.sources(workspace_id, ingested_at desc);

alter table public.sources enable row level security;

create policy "Members can read sources"
  on public.sources for select
  using (public.is_workspace_member(workspace_id));

create policy "Members can write sources"
  on public.sources for all
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- ─────────────────────────────────────────────────────────────
-- posts.source_id (cluster attribution)
-- ─────────────────────────────────────────────────────────────
-- Nullable + ON DELETE SET NULL so deleting a source preserves the audit
-- trail of posts already published from it. Analytics rolls engagement up
-- via this FK; rows where source_id IS NULL are simply excluded from
-- source-attribution dashboards.
alter table public.posts
  add column if not exists source_id uuid references public.sources(id) on delete set null;

-- Partial index — the dashboard query only looks at non-null source_id.
create index if not exists posts_source_id_idx
  on public.posts(source_id)
  where source_id is not null;
