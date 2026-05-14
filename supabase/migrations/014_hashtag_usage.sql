-- marketingmagic · 014 — hashtag_usage (Phase 6.10 Hashtag Intelligence)
--
-- Per-workspace, per-channel hashtag history. Every time we (or the
-- backfill) detect a hashtag in a post.text, we store one row here with
-- the post's engagement at the time of recording. The recommender ranks
-- tags by recency-weighted engagement.
--
-- Recommendation-only — nothing in this table is ever auto-applied to a
-- draft. The /queue UI surfaces pre-checked chips the user can toggle.
--
-- Why a separate table (vs. parsing posts.text on the fly):
--   • Backfill is one-shot; serving recommendations is hot. A focused
--     index on (workspace_id, channel, recorded_at desc) beats a regex
--     scan of every posts row on every plan generation.
--   • Engagement-at-the-time-of-recording snapshots performance so the
--     recommender doesn't have to re-join post_metrics for every query.
--   • Lets us add competitor-watch tag harvest later (Phase 6.6) into
--     the same table with a nullable post_id and a `source` column.
--
-- Channel-specific UI policy lives in src/lib/hashtags/rules.ts so the
-- DB stays a flat history table — what to *show* is a presentation
-- concern, not a storage concern.
--
-- ─────────────────────────────────────────────────────────────
-- ENV PROVISIONING NOTE
-- ─────────────────────────────────────────────────────────────
-- Phase 6.10 adds no new env vars. Backfill is reachable as a one-shot
-- admin endpoint at /api/admin/backfill-hashtags, auth via the existing
-- CRON_SECRET bearer (same posture as the other crons).
-- ─────────────────────────────────────────────────────────────

create table if not exists public.hashtag_usage (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- Mirrors posts.channel — same enum-as-text shape. We don't FK to
  -- channels because there's no channels table; the column matches
  -- src/lib/channels/registry.ts.
  channel text not null,
  -- Normalized: lowercase, no leading #. Length cap matches the
  -- max-handle conventions across X / IG / etc. (none allows >100 char
  -- tags). Enforced again at the application layer.
  tag text not null,
  -- Optional FK to the source post — NULL for competitor-harvested tags
  -- when that lands in Phase 6.6.
  post_id uuid references public.posts(id) on delete cascade,
  -- Engagement rate at the time of recording. NULL when the post hasn't
  -- been scored yet (just-shipped posts), which is fine — the recommender
  -- uses COALESCE(engagement_at_post, 0) in its ranking.
  engagement_at_post numeric,
  recorded_at timestamptz not null default now(),

  -- Idempotency for the backfill: re-running it never duplicates rows
  -- for the same (post, tag) pair.
  unique (post_id, tag),

  -- Tag normalization is application-side; keep a CHECK so a bad insert
  -- can't poison the data set.
  check (tag = lower(tag) and tag !~ '^#'),
  check (length(tag) between 1 and 100)
);

-- Hot path: "give me the last 90 days of tag-by-channel for this
-- workspace, ordered by recency."
create index if not exists hashtag_usage_workspace_channel_idx
  on public.hashtag_usage (workspace_id, channel, recorded_at desc);

-- Secondary: drop-all-tags-for-post for the backfill's
-- ON CONFLICT (post_id, tag) DO NOTHING path. The unique index above
-- already covers this, but Postgres uses it as a btree on (post_id, tag)
-- which is fine for our needs.

alter table public.hashtag_usage enable row level security;

-- Workspace members can read + write. Matches the pattern on
-- integrations / event_rules — agency editors need to manage tag history
-- without bumping into owner-only checks.
create policy "Members can read hashtag_usage"
  on public.hashtag_usage for select
  using (public.is_workspace_member(workspace_id));

create policy "Members can write hashtag_usage"
  on public.hashtag_usage for all
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
