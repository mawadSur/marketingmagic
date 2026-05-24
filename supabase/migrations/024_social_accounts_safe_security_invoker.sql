-- marketingmagic · 024 — Switch public.social_accounts_safe to SECURITY INVOKER
--
-- Supabase advisor flagged the view as SECURITY DEFINER. Postgres 15+ views
-- default to definer semantics — they enforce the view creator's permissions
-- and RLS, not the querying user's. For social_accounts_safe that's the wrong
-- posture: we *want* the caller's workspace-membership RLS on the underlying
-- public.social_accounts table to gate the rows the view returns. Otherwise
-- a user could read social_accounts_safe and see rows their RLS would normally
-- hide on the base table.
--
-- Fix: recreate the view with `security_invoker = true` (Postgres 15+).
-- The column list is unchanged from migration 001 — this only flips the
-- security model so the view inherits the caller's RLS on social_accounts.
--
-- Reversible: `alter view ... reset (security_invoker)` returns to the default.

create or replace view public.social_accounts_safe
  with (security_invoker = true)
  as
  select
    id, workspace_id, channel, handle, trust_mode, trust_threshold,
    successful_post_count, status, created_at, updated_at
  from public.social_accounts;
