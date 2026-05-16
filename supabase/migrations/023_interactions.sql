-- marketingmagic · 023 — Reply Inbox + Engagement Assistant (Phase 4.5)
--
-- Unified inbox of inbound interactions across social channels — replies,
-- mentions, comments. Each row is a single inbound item from one channel.
-- Per-channel pollers (X, LinkedIn, Bluesky to start; IG/Threads gated on
-- Meta App Review) insert rows; the /inbox UI lets the user triage them.
--
-- Draft-only philosophy: this table never represents an outbound reply.
-- When a user replies, the helper posts via the channel API and stamps
-- `status='replied'` + `replied_to_post_id` (FK into posts) so we can audit
-- via the existing approvals table. There is no "auto-send" path — even
-- with trust_mode enabled on a social_account, REPLIES always require an
-- explicit user click. The hard rule is documented in
-- `src/lib/interactions/draft-reply.ts`.
--
-- Channels supported at ship:
--   - x        (mentions + replies via existing OAuth 1.0a creds)
--   - linkedin (comments via existing UGC API)
--   - bluesky  (notifications via app.bsky.notification.listNotifications)
--   - instagram / threads: rows allowed in the schema, but the pollers
--                          throw MetaAppReviewPendingError. Schema is
--                          ready when Meta scopes land.
--
-- ─────────────────────────────────────────────────────────────
-- ENV PROVISIONING NOTE
-- ─────────────────────────────────────────────────────────────
-- Phase 4.5 adds NO new env vars. The poll-interactions cron uses the
-- existing CRON_SECRET bearer; per-channel API helpers reuse the
-- credentials already stored on social_accounts.
-- ─────────────────────────────────────────────────────────────

create table if not exists public.interactions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- Which connected account the interaction was pulled from. Drops with
  -- the account; reconnecting yields fresh rows.
  social_account_id uuid not null references public.social_accounts(id) on delete cascade,
  -- Mirrors posts.channel. Same string-as-enum shape used across the codebase.
  channel text not null
    check (channel in ('x', 'linkedin', 'bluesky', 'instagram', 'threads')),
  -- Platform-native id for the inbound item (tweet id, AT-URI, LinkedIn
  -- comment URN, etc.). Together with `channel` this is the dedup key.
  external_id text not null,
  -- If the inbound is a reply/comment on one of OUR posts, link the local
  -- post row so the detail view can show thread context. NULL when the
  -- inbound is a top-level mention with no parent we own.
  parent_post_id uuid references public.posts(id) on delete set null,
  -- Author handle as seen on the platform (e.g. "alice", "alice.bsky.social").
  -- We do NOT normalise — the platform's own canonical form is the most
  -- useful for deep-linking back.
  author_handle text not null,
  -- Optional display name (the "Display Name" on the platform).
  author_display_name text,
  -- The actual body text. Cap at 8000 to match the cap we use on
  -- competitor_posts.text — long enough for LinkedIn comments.
  body text not null,
  -- When the platform says the interaction happened. Distinct from the
  -- row's created_at (when we pulled it).
  received_at timestamptz not null,
  -- Lifecycle. `unread` = freshly pulled. `read` = user opened detail
  -- view OR our priority recompute downgraded it (e.g. native-reply
  -- conflict). `replied` = we sent a reply via the inbox composer.
  -- `snoozed` + snooze_until = hidden from default filters until the
  -- timestamp passes. `dismissed` = manually cleared.
  status text not null default 'unread'
    check (status in ('unread', 'read', 'replied', 'snoozed', 'dismissed')),
  -- 0-100 priority blend. Computed by src/lib/interactions/priority.ts
  -- on insert and again on poll-time recompute. NULL until the first
  -- compute lands (e.g. a transient insert from a backfill script).
  priority_score numeric,
  -- When the row is snoozed. Default-filtered UI hides until this passes.
  -- Always NULL when status != 'snoozed'.
  snooze_until timestamptz,
  -- When we replied. Set together with status='replied' and
  -- replied_to_post_id by sendReplyAction. NULL otherwise.
  replied_at timestamptz,
  -- The posts row created by the reply send helper. FK is permissive
  -- (no constraint to posts) because: (a) the reply uses a synthetic
  -- post row we already create today via the social pipeline, (b)
  -- ON DELETE SET NULL on the FK would mean a deleted post wipes the
  -- audit trail — we'd rather keep the row's reply marker pointing at
  -- a tombstone uuid than lose it. Treated as a soft pointer.
  replied_to_post_id uuid,
  created_at timestamptz not null default now(),

  -- Dedup: same external id from the same channel is one row.
  unique (channel, external_id),

  check (length(external_id) between 1 and 200),
  check (length(author_handle) between 1 and 200),
  check (length(body) between 1 and 8000),
  -- A snoozed row must carry its target wake-up time. We don't enforce
  -- the inverse (snooze_until is null when not snoozed) so resetting
  -- the status doesn't require a second column update — the UI ignores
  -- snooze_until unless status='snoozed'.
  check (status <> 'snoozed' or snooze_until is not null),
  -- A replied row must have a replied_at timestamp.
  check (status <> 'replied' or replied_at is not null)
);

-- Hot path 1: the inbox UI's default timeline — workspace × status
-- × received_at desc. Covers the "show unread, newest first" query plus
-- filter-by-status variants.
create index if not exists interactions_workspace_status_received_idx
  on public.interactions (workspace_id, status, received_at desc);

-- Hot path 2: triaged priority list — workspace × priority desc,
-- partial index on unread only. The inbox UI sorts by priority_score
-- desc then received_at desc; this index covers the priority half and
-- the planner can use it for the top-N call.
create index if not exists interactions_workspace_priority_idx
  on public.interactions (workspace_id, priority_score desc)
  where status = 'unread';

-- Hot path 3: snooze sweeper. The cron (or a future sweeper) wakes up
-- snoozed rows whose snooze_until has passed. Partial-on-snoozed keeps
-- the index tiny.
create index if not exists interactions_snooze_idx
  on public.interactions (snooze_until)
  where status = 'snoozed';

-- Hot path 4: rolling up "engagement debt" (unread interactions older
-- than N hours). Same workspace × received_at slice the dashboard
-- widget uses. We piggyback on the workspace_status_received_idx for
-- this — no separate index needed.

alter table public.interactions enable row level security;

create policy "Members can read interactions"
  on public.interactions for select
  using (public.is_workspace_member(workspace_id));

create policy "Members can write interactions"
  on public.interactions for all
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

comment on table public.interactions is
  'Phase 4.5: unified inbox of inbound replies/mentions/comments across channels. Draft-only — never auto-sends.';
comment on column public.interactions.priority_score is
  '0-100 blend of verified-author, follower-log, customer-match, question-detection, age decay. Recomputed on every poll.';
comment on column public.interactions.replied_to_post_id is
  'Soft pointer (no FK) to the synthetic posts row created when we replied. See src/lib/interactions/draft-reply.ts.';
