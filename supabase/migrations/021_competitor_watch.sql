-- marketingmagic · 021 — Competitor Watch (Phase 6.6)
--
-- Premium-gated (Founder/Agency) per-workspace watch list of competitor
-- handles. Two tables:
--
--   watch_handles      — one row per (workspace, channel, handle) pair.
--                        Daily cron pulls public posts for each row, with
--                        per-channel backoff + status tracking.
--
--   competitor_posts   — outlier-winner cache per handle. Holds the last
--                        90 days of pulled posts plus computed engagement
--                        rate and (for winners only) Claude-generated
--                        pattern tags / one-line reason.
--
-- Anti-harassment + abuse hygiene:
--   - Handles are normalised to lowercase + no leading "@" at insert time
--     (application layer enforces; DB has a CHECK for the "@" prefix).
--   - There's no surface in this schema for "draft a takedown" of a
--     handle. Counter-content uses the existing Phase 2.5 source pipeline
--     with a system-prompt that explicitly refuses adversarial framings.
--
-- Channel support reality (V1):
--   - bluesky: fully supported via public ATproto getAuthorFeed.
--   - x:       best-effort via existing OAuth creds (requires the user to
--              have an X connection in social_accounts; reads tweets via
--              GET /2/users/:id/tweets which is in the elevated tier).
--   - linkedin / instagram / threads: documented as "coming when their
--              public-read APIs allow it." Rows accepted but the daily
--              cron flags status='failed' with reason='channel_unsupported'.
--
-- ─────────────────────────────────────────────────────────────
-- ENV PROVISIONING NOTE
-- ─────────────────────────────────────────────────────────────
-- Phase 6.6 adds NO new env vars. Daily cron uses the existing CRON_SECRET
-- bearer. Per-channel API helpers reuse existing credentials stored on
-- social_accounts (X) or hit the public ATproto endpoint (Bluesky).
-- ─────────────────────────────────────────────────────────────

create table if not exists public.watch_handles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- Mirrors posts.channel. Same string-as-enum shape used across the codebase.
  channel text not null,
  -- Normalised: lowercase, no leading "@". For Bluesky we accept either
  -- "alice" (coerced to "alice.bsky.social") or full handle.
  handle text not null,
  -- Optional pretty display name (the "Display Name" on the platform).
  display_name text,
  -- Lifecycle status of the watch row. The daily cron updates this to
  -- 'rate_limited' / 'failed' on errors and resets to 'active' on a
  -- successful pull. 'paused' is user-driven.
  status text not null default 'active'
    check (status in ('active', 'failed', 'rate_limited', 'paused')),
  -- Free-form reason set alongside status when something fails. Surfaced
  -- in the /competitors UI so the user knows why a row is stuck.
  failure_reason text,
  -- Most recent successful pull timestamp; null until the first run lands.
  last_pulled_at timestamptz,
  -- Who added this row (audit; nullable for system-added entries).
  added_by uuid references auth.users(id) on delete set null,
  added_at timestamptz not null default now(),

  -- One watch row per (workspace, channel, handle). Re-adding a removed
  -- row is a regular insert; we don't soft-delete because the UI's
  -- "Stop watching" action drops the row entirely.
  unique (workspace_id, channel, handle),

  check (channel in ('x', 'bluesky', 'linkedin', 'instagram', 'threads')),
  -- Storage hygiene: prevent the "@" prefix from sneaking in.
  check (handle = lower(handle) and handle !~ '^@'),
  check (length(handle) between 1 and 120)
);

-- Hot path: cron iteration ordered by oldest pull first ("which handles
-- are most behind?").
create index if not exists watch_handles_workspace_status_idx
  on public.watch_handles (workspace_id, status, last_pulled_at);

alter table public.watch_handles enable row level security;

create policy "Members can read watch_handles"
  on public.watch_handles for select
  using (public.is_workspace_member(workspace_id));

create policy "Members can write watch_handles"
  on public.watch_handles for all
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- ─────────────────────────────────────────────────────────────
-- competitor_posts: per-handle post cache + winners.
-- ─────────────────────────────────────────────────────────────
--
-- We cache the last ~90 days of pulled posts so:
--   1. Outlier detection has a stable baseline per handle (top-10%
--      engagement rate against that account's own median, not a
--      cross-handle global).
--   2. The /competitors UI can show recent winners without re-pulling.
--   3. The weekly digest can rank winners across the workspace.
--
-- We DON'T store full media / URLs / attachments — just text + counts +
-- an external_id so the UI can deep-link back to the source post if the
-- channel supports it.

create table if not exists public.competitor_posts (
  id uuid primary key default gen_random_uuid(),
  watch_handle_id uuid not null references public.watch_handles(id) on delete cascade,
  -- Denormalised workspace_id so RLS can match without joining.
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- Platform-native post id ("tweet id", Bluesky AT-URI, etc.). Together
  -- with watch_handle_id this is the dedup key.
  external_id text not null,
  -- Public URL for the post when the platform exposes one (Bluesky web
  -- view, x.com/.../status/...). Null when not constructable.
  post_url text,
  posted_at timestamptz not null,
  text text not null default '',
  -- Raw counts the channel exposes. All nullable because not every
  -- platform reports every metric (Bluesky has no impressions number).
  likes integer,
  reposts integer,
  replies integer,
  impressions integer,
  -- Computed: likes+reposts+replies divided by impressions when present,
  -- otherwise divided by max(handle median follower count, 1). The cron
  -- writes this on insert so the outlier-detection pass is a single
  -- table scan.
  engagement_rate numeric,
  -- Outlier flag. Set by detect-outliers.ts once a handle has at least
  -- MIN_POSTS_FOR_BASELINE entries.
  is_winner boolean not null default false,
  -- Claude-extracted pattern tags + one-line "possible reason". Only
  -- populated for winners (we don't burn Claude tokens on the long
  -- tail). Null until extract-pattern.ts runs.
  pattern_tags text[],
  pattern_reason text,
  -- When the row was first inserted by the cron.
  fetched_at timestamptz not null default now(),
  -- Set when used as the seed for a counter-content draft (so the UI
  -- can show "drafted on YYYY-MM-DD" and prevent re-drafting noise).
  drafted_at timestamptz,
  drafted_by uuid references auth.users(id) on delete set null,

  -- Dedup: same external post for the same handle row = no duplicate.
  unique (watch_handle_id, external_id),

  check (length(external_id) between 1 and 200),
  check (text = '' or length(text) <= 8000)
);

-- Hot paths:
--   1. /competitors UI — "show me recent winners for workspace X."
--   2. Outlier detection — "give me all posts for handle H ordered by
--      posted_at to compute the rolling baseline."
create index if not exists competitor_posts_workspace_winner_idx
  on public.competitor_posts (workspace_id, is_winner, posted_at desc);

create index if not exists competitor_posts_handle_posted_idx
  on public.competitor_posts (watch_handle_id, posted_at desc);

alter table public.competitor_posts enable row level security;

create policy "Members can read competitor_posts"
  on public.competitor_posts for select
  using (public.is_workspace_member(workspace_id));

create policy "Members can write competitor_posts"
  on public.competitor_posts for all
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

comment on table public.watch_handles is
  'Phase 6.6: per-workspace competitor watch list. Founder/Agency tier only at the application layer.';
comment on table public.competitor_posts is
  'Phase 6.6: cached per-handle public post pulls + winner flags + Claude pattern extraction.';
