-- marketingmagic · 066 — public API keys
--
-- Phase 1 of the agent-native roadmap (docs/designs/postiz-competitive-roadmap.md):
-- a public REST API at /api/v1 that AI agents, MCP, and automation tools (n8n /
-- Make / Zapier) can call. The whole app today authenticates via Supabase auth
-- cookies + RLS (is_workspace_member). A public API has no cookie — it authenticates
-- by API KEY → resolve workspace → service-role client.
--
-- SECURITY MODEL — the load-bearing fact: the API path uses supabaseService(),
-- whose service-role key BYPASSES RLS. So this table's RLS protects the management
-- UI (cookie-authed members read/manage their own workspace's keys), but the API
-- request path itself does NOT rely on RLS — every API query is workspace-scoped in
-- application code via the ApiContext facade (src/lib/api/context.ts). See that file.
--
-- KEY STORAGE: we store ONLY the SHA-256 hash of the secret, never the raw key.
-- The raw key (format `mm_live_<base62>`) is shown exactly once at creation and is
-- unrecoverable after — same model as GitHub PATs / Stripe keys. key_prefix keeps a
-- short non-secret slice (`mm_live_a1b2…`) so the UI can identify a key in a list.

create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- Human label set by the user, e.g. "n8n production", "zapier".
  name text not null,
  -- Non-secret identifying slice shown in the management UI (the raw key is
  -- never stored). e.g. "mm_live_a1b2c3d4".
  key_prefix text not null,
  -- SHA-256 (hex) of the full raw secret. UNIQUE so a collision/duplicate insert
  -- fails loudly. The raw key is never persisted anywhere.
  key_hash text not null unique,
  -- Per-key scopes gating what the key can do (e.g. 'posts:write', 'plans:read').
  -- Empty array = no permissions (key can authenticate but every scoped route 403s).
  scopes text[] not null default '{}',
  -- Who minted the key (audit). ON DELETE SET NULL so removing a teammate keeps
  -- the key's audit trail intact rather than cascading the key away.
  created_by uuid references auth.users(id) on delete set null,
  -- Stamped on every successful authentication so the UI can show "last used"
  -- and operators can spot dormant keys to revoke.
  last_used_at timestamptz,
  -- Soft-revoke: non-null = dead. We never hard-delete so a leaked-key incident
  -- keeps its audit trail. resolveApiKey() rejects any row with revoked_at set.
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists api_keys_workspace_idx on public.api_keys(workspace_id);
-- The API auth hot path looks a key up by hash; partial index skips revoked rows.
create index if not exists api_keys_hash_idx on public.api_keys(key_hash) where revoked_at is null;

-- RLS governs the COOKIE-authed management UI only (members of a workspace can
-- read + manage that workspace's keys). The API request path uses the service
-- role (bypasses RLS) and looks rows up by key_hash directly — see the security
-- note at the top of this file and src/lib/api/context.ts.
alter table public.api_keys enable row level security;

create policy "Members read their workspace API keys"
  on public.api_keys for select
  using (public.is_workspace_member(workspace_id));

create policy "Members manage their workspace API keys"
  on public.api_keys for all
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
