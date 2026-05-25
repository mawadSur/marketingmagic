-- marketingmagic · 025 — allow 'founder' in workspaces.plan CHECK constraint
--
-- Bug: Phase 2.6 added the Founder tier (commit cdfd53b) but never updated
-- the CHECK constraint from migration 005_billing.sql, which only allowed
-- ('hobby', 'pro', 'agency'). Every customer.subscription.created event
-- for a Founder subscription was being silently rejected at the DB layer:
-- PostgREST returned a 23514 check_violation, supabase-js returned that as
-- { data: null, error }, and the webhook handler ignored the error (no
-- throw), returned 200 to Stripe, and the workspace stayed on whatever
-- plan it had before. Indistinguishable from a quiet success.
--
-- This migration drops the auto-named constraint and re-adds it with
-- 'founder' included. We do NOT rename — Postgres uses the implicit
-- `<table>_<column>_check` naming for inline column-level checks, so
-- workspaces_plan_check is the target.

alter table public.workspaces
  drop constraint if exists workspaces_plan_check;

alter table public.workspaces
  add constraint workspaces_plan_check
  check (plan in ('hobby', 'pro', 'agency', 'founder'));
