-- marketingmagic · 057 — pricing_grandfather (Blotato-competitive pricing)
--
-- Adds a per-subscriber "grandfather" timestamp used purely as a SCHEDULING +
-- NOTICE marker for the pricing restructure (Free $0 / Solo $29 / Creator $97 /
-- Agency $499). The new ladder reuses the existing plan enum ids
-- (hobby / pro / founder / agency) — NO plan column or value changes here.
--
--   workspaces.grandfathered_until    timestamptz null
--   organizations.grandfathered_until timestamptz null
--
--     NULL (DEFAULT) → not grandfathered. Either a brand-new subscriber already
--                      on the new price, or a row the operator hasn't flagged.
--                      The billing UI shows the normal plan/price.
--     <future ts>    → this subscriber is STILL ON THEIR OLD STRIPE PRICE and
--                      will be moved to the new price on/after this date (the
--                      operator does the actual Stripe move at renewal). The
--                      billing UI reads this to show a friendly
--                      "Your plan moves to $X on <date>" notice instead of
--                      surprising them. A past timestamp means the migration
--                      window has elapsed (notice can stop showing).
--
-- WHY A TIMESTAMP, NOT A BOOLEAN: we want to render an exact date in the
-- notice and to let the value naturally "expire" (once the date passes, the
-- subscriber has been migrated and the notice is moot) without a follow-up
-- write. A boolean would need a second "when" column anyway.
--
-- IMPORTANT — THIS MIGRATION DOES NOT TOUCH STRIPE. Existing customers keep
-- their CURRENT Stripe price until the OPERATOR migrates each subscription in
-- the Stripe Dashboard (proration at renewal). This column only records WHEN
-- that change takes effect so the app can show a heads-up. See
-- docs/pricing-migration-runbook.md for the operator's exact enum→price steps.
--
-- ADDITIVE + IDEMPOTENT: `add column if not exists`, nullable, no default value
-- written to existing rows, no backfill. Safe to re-run. RLS is inherited from
-- the parent tables (workspaces / organizations already enforce workspace- and
-- org-scoped row-level security) — a nullable column add needs no new policy.

alter table public.workspaces
  add column if not exists grandfathered_until timestamptz;

alter table public.organizations
  add column if not exists grandfathered_until timestamptz;

comment on column public.workspaces.grandfathered_until is
  'Blotato pricing migration (057): when set + in the future, this solo workspace is still on its OLD Stripe price and the billing UI shows a "your plan moves to $X on <date>" notice. NULL = not grandfathered. The actual Stripe price move is done by the operator (proration at renewal); this column is a notice/scheduling marker only.';

comment on column public.organizations.grandfathered_until is
  'Blotato pricing migration (057): when set + in the future, this organization is still on its OLD Stripe (per-seat) price and the org billing UI shows a "your plan moves to $X on <date>" notice. NULL = not grandfathered. The actual Stripe price move is done by the operator; this column is a notice/scheduling marker only.';
