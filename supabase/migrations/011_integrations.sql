-- marketingmagic · 011 — third-party transport integrations (Discord)
--
-- Phase 4.7. Approve-from-anywhere via a Discord bot installed to a server
-- channel. One row per (workspace, channel) destination — a workspace can
-- route to multiple channels (e.g. #content for digest, #posts-only for
-- real-time alerts) and an agency-style workspace can stretch one server
-- across two destinations.
--
-- Slack is intentionally deferred. The `provider` enum is open via CHECK so
-- adding `slack` later is a single ALTER, no schema rewrite — but we don't
-- pre-add it; it would just be dead surface area.
--
-- ─────────────────────────────────────────────────────────────
-- ENV PROVISIONING NOTE
-- ─────────────────────────────────────────────────────────────
-- .env.local.example is permission-blocked in our isolated worktree, so the
-- canonical Discord env block lives here as well. When merging back, copy
-- this block to .env.local.example verbatim:
--
--   # Discord bot integration for Phase 4.7 (digest + interactive approval).
--   # Optional — when unset, /integrations/discord shows a "configure to enable"
--   # state and no Discord webhooks fire.
--   #
--   # How to obtain:
--   # 1. Go to https://discord.com/developers/applications
--   # 2. Click "New Application", give it a name (e.g., "marketingmagic")
--   # 3. From the General Information tab, copy:
--   #      - Application ID  → DISCORD_CLIENT_ID
--   #      - Public Key      → DISCORD_PUBLIC_KEY
--   # 4. From the OAuth2 tab, click "Reset Secret" → DISCORD_CLIENT_SECRET
--   # 5. From the Bot tab, click "Reset Token" → DISCORD_BOT_TOKEN
--   # 6. From the OAuth2 → URL Generator tab, select scopes: bot,
--   #    applications.commands; bot permissions: Send Messages, Embed Links,
--   #    Read Message History
--   # 7. Set Interactions Endpoint URL to:
--   #    {YOUR_SITE_URL}/api/integrations/discord/action
--   DISCORD_CLIENT_ID=
--   DISCORD_CLIENT_SECRET=
--   DISCORD_PUBLIC_KEY=
--   DISCORD_BOT_TOKEN=
--
-- ─────────────────────────────────────────────────────────────

create table if not exists public.integrations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- Provider is a CHECK rather than a Postgres ENUM so we never need a
  -- migration to add slack/teams/etc. — just bump the check constraint.
  provider text not null check (provider in ('discord')),
  -- Snowflake IDs come from Discord as strings (>53-bit ints). Always store
  -- as text — never cast to bigint, you'll lose precision in JSON round-trips.
  target_channel_id text not null,
  target_guild_id text,
  -- Bot install metadata: { access_token?, scope?, guild_name?, installed_user_id }
  -- Currently optional because bot-token-only installs don't return an OAuth
  -- token. Encrypted-at-rest by the underlying Supabase / pg storage layer
  -- (and protected by RLS below) — same posture as social_accounts.credentials.
  auth_payload jsonb,
  -- Per-event filter. Defaults to digest-only (quietest setting) so a fresh
  -- install never floods a channel before the operator tunes it.
  --   - digest: bool       — daily summary embed at digest cron time
  --   - realtime: bool     — every new pending_approval post fires an embed
  --   - alerts_only: bool  — only fires for high-priority alerts (errors,
  --                          billing nudges, etc.). Reserved; not wired yet.
  event_filters jsonb not null default
    '{"digest": true, "realtime": false, "alerts_only": false}'::jsonb,
  installed_by uuid references auth.users(id) on delete set null,
  installed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  -- One destination per (workspace, provider, channel). A user re-installing
  -- the bot to the same channel upserts onto this constraint.
  unique (workspace_id, provider, target_channel_id)
);

-- Lookup-by-workspace is the hot path (digest cron walks workspaces, asks
-- "does this workspace have any active Discord integrations?"). Partial
-- index keeps the index tiny when slack/teams/etc. land later.
create index if not exists integrations_workspace_discord_idx
  on public.integrations(workspace_id)
  where provider = 'discord';

alter table public.integrations enable row level security;

-- Read: any workspace member. Write: any workspace member (matches the
-- existing pattern on social_accounts / event_rules — agency editors
-- need to manage routing without bumping into owner-only checks).
create policy "Members can read integrations"
  on public.integrations for select
  using (public.is_workspace_member(workspace_id));

create policy "Members can write integrations"
  on public.integrations for all
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
