-- marketingmagic · 063 — handle availability cache (handle-finder pipeline)
--
-- The handle finder generates brandable usernames and checks them across the 8
-- channels. Only Bluesky has a real availability API; the other 7 are best-effort
-- HTTP probes. This table CACHES every probe result so we never re-hammer a
-- platform for the same (handle, platform) within a TTL — protecting both our
-- egress and the platforms' rate limits (a user clicking "find handles" repeatedly,
-- or many users converging on the same obvious handle, must not fan out into
-- duplicate outbound requests).
--
-- GLOBAL cache (not workspace-scoped): "is x.com/acme taken?" is the same answer
-- for everyone, so a hit set by workspace A serves workspace B. There is no
-- user data here — only a public handle, a platform, and a coarse status — so it
-- needs no RLS read scoping (service-role writes it; the app reads via the
-- service path during the check action). We still enable RLS with NO policies so
-- the table is locked to the service role by default (anon/auth can't read or
-- write), matching the project's deny-by-default posture for non-user tables.

create table if not exists public.handle_checks (
  -- The bare, normalised handle (no leading @, lowercased) that was probed.
  handle text not null,
  -- Which platform this result is for (mirrors the Channel enum's values).
  platform text not null,
  -- Coarse outcome:
  --   'available' — probe says nobody holds it (Bluesky: authoritative; http: signal).
  --   'taken'     — probe says it's in use.
  --   'unknown'   — probe was inconclusive (timeout, block, ambiguous response).
  --   'invalid'   — handle can't exist on this platform (format) — cached so we
  --                 never re-probe a structurally-impossible handle.
  status text not null check (status in ('available', 'taken', 'unknown', 'invalid')),
  -- How the result was obtained ('bluesky' | 'http') — for debugging + so we can
  -- treat an http signal differently from an authoritative bluesky result later.
  source text not null,
  -- When this result was recorded. TTL freshness is computed on read.
  checked_at timestamptz not null default now(),
  -- One cached row per (handle, platform); a re-check UPSERTs it.
  primary key (handle, platform)
);

-- Freshness scans ("which cached rows are still within TTL?") filter by time.
create index if not exists handle_checks_checked_at_idx
  on public.handle_checks(checked_at);

-- Lock to the service role: RLS on, no policies → anon/auth denied, service-role
-- bypasses. No user-scoped data lives here, so there's nothing to scope per user.
alter table public.handle_checks enable row level security;
