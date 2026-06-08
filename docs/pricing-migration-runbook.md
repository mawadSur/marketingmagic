# Pricing migration runbook — Blotato-competitive ladder

**Audience:** the operator (you), doing the Stripe + comms work.
**Scope:** moving marketingmagic from the old prices to the new ladder.
**Status:** the CODE is shipped (enum ids unchanged; new display names/prices/
limits live in `src/lib/billing/tiers.ts`). NO Stripe call has been made by the
code change. Everything below is manual operator work.

> **The golden rule:** existing customers stay on their **current** Stripe price
> until you move them. Nothing in the app charges anyone the new price. The
> `grandfathered_until` column (migration 057) is only a *notice* marker so the
> billing page can say "your plan moves to $X on <date>".

---

## The new ladder

| Display name | Enum id (UNCHANGED) | Old price | **New price** | AI writing | AI credits (images + video) | Voice memo |
| ------------ | ------------------- | --------- | ------------- | ---------- | --------------------------- | ---------- |
| Free         | `hobby`             | $0        | $0            | 10 posts   | 0                           | no         |
| Solo         | `pro`               | $29       | **$29**       | Unlimited  | 1,250 (1000 img + 250 vid)  | no         |
| Creator      | `founder`           | $149      | **$97**       | Unlimited  | 5,000 (4000 img + 1000 vid) | **yes**    |
| Agency       | `agency`            | $99       | **$499**      | Unlimited  | 28,000 (22000 img + 6000 vid) | no       |

Notes:
- **Enum ids did not change.** `hobby` / `pro` / `founder` / `agency` are exactly
  as before, so the Stripe webhook, every `workspaces.plan` / `organizations.plan`
  row, and the `STRIPE_PRICE_*` env vars keep working with **no data migration**.
- "Creator" is a **display rename** of the `founder` enum. `hasFounderMode()` and
  `hasCompetitorWatch()` still key off `id === 'founder'`, so the voice-memo
  recorder and Competitor Watch perks follow the Creator tier automatically.
- "AI credits" is a **presentation aggregate** = `imageGensPerMonth + videosPerMonth`
  (`aiCreditsFor()` in `tiers.ts`). The backend still meters images and video as
  two separate counters; nothing about metering changed.
- `agency` is **also** the org / multi-workspace tier (org subscriptions resolve
  to `agency`). The per-seat **org** price is the separate `STRIPE_PRICE_ORG_SEAT`
  — only touch it if the org seat price itself is changing.

---

## Step 1 — Create the new Stripe prices

In the Stripe Dashboard (Products → your product → add price), create three new
**monthly recurring** prices. Do NOT archive the old prices yet — existing subs
still reference them.

| Create this price | Set this env var      | Notes |
| ----------------- | --------------------- | ----- |
| Solo **$29/mo**   | `STRIPE_PRICE_PRO`    | If the $29 already exists, you may reuse its id. |
| Creator **$97/mo**| `STRIPE_PRICE_CREATOR`| New price (was $149). Env var renamed from `STRIPE_PRICE_FOUNDER`. |
| Agency **$499/mo**| `STRIPE_PRICE_AGENCY` | New price (was $99). |

Set the env vars on Vercel (Production + Preview). Redeploy. After this:
- **New** checkouts hit the new prices.
- **Existing** subscribers are unaffected — they keep their old price until Step 3.
- The webhook's `planForPriceId()` maps the new price ids → the same enum ids, so
  newly-created subscriptions land on the right plan. (Old price ids no longer
  match an env var; existing subs are matched by `subscription_status` + the price
  they already carry until you move them in Step 3.)

> Graceful degrade: if any `STRIPE_PRICE_*` is unset, the billing UI hides that
> tier's upgrade button and `priceIdForPlan()` returns `null`. The app never
> crashes and no fake price ids exist anywhere.

## Step 2 — Notify existing customers + set the grandfather notice

For every existing PAYING subscriber whose price is changing (Creator $149→$97 is
a *decrease* — no notice strictly needed; Agency $99→$499 is an *increase* — give
ample notice; Solo $29 unchanged — skip):

1. Email them the change and the effective date (typically their next renewal,
   or 30+ days out for an increase — follow your local consumer-law notice period).
2. Record the cutover date so the app shows a heads-up. For a **solo** workspace:

   ```sql
   update public.workspaces
     set grandfathered_until = '2026-08-01T00:00:00Z'   -- the cutover date
     where id = '<workspace-uuid>';
   ```

   For an **org**:

   ```sql
   update public.organizations
     set grandfathered_until = '2026-08-01T00:00:00Z'
     where id = '<organization-uuid>';
   ```

   The billing page then shows: *"Your <Plan> plan moves to $X on <date>."* Once
   the date passes, the notice stops showing on its own (no follow-up write).

## Step 3 — Move each subscription to the new price (at renewal)

On/after each customer's cutover date, in the Stripe Dashboard (or API), update
the subscription item's price to the new price id. Use **proration at renewal**
(Stripe "update subscription", billing behaviour = "create prorations" or
"none" at period end, per your notice).

- `pro` subs → new Solo $29 price (`STRIPE_PRICE_PRO`)
- `founder` subs → new Creator $97 price (`STRIPE_PRICE_CREATOR`)
- `agency` subs → new Agency $499 price (`STRIPE_PRICE_AGENCY`)
- org subs → unchanged unless `STRIPE_PRICE_ORG_SEAT` is moving

When Stripe emits `customer.subscription.updated`, our webhook resolves the new
price via `planForPriceId()` → the **same enum id** the subscriber already had,
so `workspaces.plan` / `organizations.plan` does **not** change — only the amount
billed does. After moving a subscriber you may clear their notice:

```sql
update public.workspaces set grandfathered_until = null where id = '<uuid>';
```

## Step 4 — Clean up

Once **all** subscribers are off an old price, archive the old Stripe prices in
the Dashboard so they can't be selected again. Verify no `workspaces.plan` /
`organizations.plan` rows changed during the migration (they shouldn't have —
enum ids were stable throughout).

---

## What this migration does NOT do

- It does **not** call Stripe from code. Steps 1 and 3 are manual operator work.
- It does **not** change any `plan` enum value or any DB plan row.
- It does **not** invent or hard-code any Stripe price id.
- It does **not** change metering — `posts_generated` / `images_generated` /
  `videos_generated` counters are untouched.
