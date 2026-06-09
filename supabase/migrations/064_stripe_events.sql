-- marketingmagic · 064 — stripe event dedupe ledger
--
-- The Stripe webhook endpoint must be idempotent (re-delivering a processed
-- event must yield the same final state) to handle Stripe's at-least-once retry
-- semantics. The current in-memory Set is lost on cold start / not shared across
-- lambda instances → an event can be processed twice on concurrent delivery or
-- after a cold start. This table is the DURABLE dedupe source of truth.
--
-- SINGLE RESPONSIBILITY: this table answers one question only — "have we seen
-- this Stripe event_id before?" It does NOT store any payload detail or event
-- state beyond "we processed this". The webhook handler still owns all business
-- logic; the table is a narrow idempotency key.
--
-- GLOBAL dedupe (not workspace-scoped): a given event.id from Stripe is globally
-- unique forever — one event.id can never map to two different subscriptions or
-- workspaces, so the dedupe check needs no workspace scope. Service-role-only:
-- the webhook writes via supabaseService; anon/auth clients never see this. We
-- still enable RLS with NO policies so the table is locked by default (deny-by-
-- default posture), matching handle_checks (migration 063).

create table if not exists public.stripe_events (
  -- Stripe's stable event identifier (evt_...). This is the dedupe key.
  event_id text primary key,
  -- Event type (e.g. 'customer.subscription.updated') for debugging/filtering.
  type text not null,
  -- When this event was first received and processed. TTL cleanup could walk
  -- this to delete old rows if the table ever grows large, but for now we keep
  -- events forever as an audit trail.
  received_at timestamptz not null default now()
);

-- Lock to the service role: RLS on, no policies → anon/auth denied, service-role
-- bypasses. No user-scoped data lives here, so there's nothing to scope per user.
alter table public.stripe_events enable row level security;
