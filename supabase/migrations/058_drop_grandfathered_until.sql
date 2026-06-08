-- marketingmagic · 058 — drop grandfathered_until
--
-- Reverts migration 057. The Blotato pricing ladder now displays to EVERYONE
-- flat-out (no "your plan moves to $X on <date>" transition notice), so the
-- per-subscriber grandfather marker is unused by the app. We drop it rather
-- than leave dead schema around.
--
-- The actual Stripe price migration for existing subscribers is operator work
-- done in the Stripe Dashboard at renewal (see docs/pricing-migration-runbook.md)
-- and never depended on this column — it was only ever a UI notice marker.
--
-- IDEMPOTENT: `drop column if exists`. Also drops the helper function 057 did
-- NOT create (057 only added columns), so nothing else to clean up. Safe to
-- re-run.

alter table public.workspaces
  drop column if exists grandfathered_until;

alter table public.organizations
  drop column if exists grandfathered_until;
