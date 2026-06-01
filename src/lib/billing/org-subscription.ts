import type Stripe from "stripe";
import { supabaseService } from "@/lib/supabase/service";
import { stripeClient } from "@/lib/billing/stripe";
import { orgSeatPriceId } from "@/lib/billing/tiers";

// ─────────────────────────────────────────────────────────────
// Org Stripe subscription — ONE subscription per organization, priced per
// active client workspace (locked decision #1). quantity === number of active
// client workspaces; adding/removing a client adjusts the quantity and Stripe
// prorates. Solo workspace billing (checkout/route.ts) is untouched — this
// module is the org-only counterpart.
// ─────────────────────────────────────────────────────────────
//
// Loud-logging discipline mirrors the webhook handler: every Stripe/DB failure
// throws an Error with a "[org-billing]" prefix and enough context (org id, sub
// id, quantity) for an operator to act from Vercel logs. Quantity sync is a
// best-effort side-effect of add/remove-client, so its caller swallows the
// throw after logging — we never want a Stripe blip to block a workspace from
// being created. See syncOrgSubscriptionQuantity for that contract.

// Count the org's active client workspaces. This is the authoritative source
// for the subscription quantity. Uses service role so the count is correct
// regardless of the caller's RLS scope (the webhook has no user session).
export async function countActiveClientWorkspaces(organizationId: string): Promise<number> {
  const svc = supabaseService();
  const { count, error } = await svc
    .from("workspaces")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId);
  if (error) {
    throw new Error(
      `[org-billing] failed to count client workspaces for org ${organizationId}: ${error.message}`,
    );
  }
  return count ?? 0;
}

// Resolve an org row's billing columns via service role. Returns null when the
// org doesn't exist.
async function getOrgBilling(organizationId: string): Promise<{
  id: string;
  name: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
} | null> {
  const svc = supabaseService();
  const { data, error } = await svc
    .from("organizations")
    .select("id, name, stripe_customer_id, stripe_subscription_id")
    .eq("id", organizationId)
    .maybeSingle();
  if (error) {
    throw new Error(
      `[org-billing] failed to read org ${organizationId}: ${error.message}`,
    );
  }
  return data ?? null;
}

// Ensure the org has a Stripe customer, creating one and persisting its id when
// absent. Returns the customer id. ownerEmail is best-effort context for the
// Stripe customer record.
export async function ensureOrgStripeCustomer(args: {
  organizationId: string;
  ownerEmail?: string | null;
}): Promise<string> {
  const org = await getOrgBilling(args.organizationId);
  if (!org) {
    throw new Error(`[org-billing] org ${args.organizationId} not found.`);
  }
  if (org.stripe_customer_id) return org.stripe_customer_id;

  const customer = await stripeClient().customers.create({
    email: args.ownerEmail ?? undefined,
    name: org.name,
    metadata: { organization_id: org.id },
  });

  const svc = supabaseService();
  const { error } = await svc
    .from("organizations")
    .update({ stripe_customer_id: customer.id })
    .eq("id", org.id);
  if (error) {
    throw new Error(
      `[org-billing] created Stripe customer ${customer.id} but failed to persist it on org ${org.id}: ${error.message}`,
    );
  }
  return customer.id;
}

// Push the org subscription's quantity to match the current active-client
// count. No-op (best-effort) when the org has no subscription yet — there's
// nothing to resize until the first checkout completes.
//
// CONTRACT: callers that invoke this as a side-effect of add/remove-client
// (server actions) should wrap it in try/catch and log — a Stripe failure must
// never block the workspace mutation. The webhook + the periodic UI render are
// the reconciliation safety nets. Callers that explicitly manage billing (the
// org billing page actions) may surface the throw to the operator.
export async function syncOrgSubscriptionQuantity(organizationId: string): Promise<void> {
  const org = await getOrgBilling(organizationId);
  if (!org) {
    throw new Error(`[org-billing] org ${organizationId} not found for quantity sync.`);
  }
  // No subscription yet — nothing to resize. Quantity is set at checkout time
  // from the same count, so the first sub starts correctly sized.
  if (!org.stripe_subscription_id) return;

  const quantity = await countActiveClientWorkspaces(organizationId);
  const stripe = stripeClient();

  let sub: Stripe.Subscription;
  try {
    sub = await stripe.subscriptions.retrieve(org.stripe_subscription_id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    throw new Error(
      `[org-billing] failed to retrieve subscription ${org.stripe_subscription_id} for org ${organizationId}: ${msg}`,
    );
  }

  const item = sub.items?.data?.[0];
  if (!item) {
    throw new Error(
      `[org-billing] subscription ${sub.id} for org ${organizationId} has no line items to resize.`,
    );
  }

  // Stripe forbids quantity 0 on a subscription item. When the org drops to
  // zero clients we leave a quantity of 1 (the operator pays for an empty
  // agency seat) rather than cancel — cancellation is an explicit action via
  // the billing portal, not an implicit side-effect of removing the last
  // client. This avoids silently terminating billing on a transient empty
  // state.
  const targetQuantity = Math.max(quantity, 1);
  if (item.quantity === targetQuantity) return; // Already in sync — skip the API call + proration noise.

  try {
    await stripe.subscriptions.update(sub.id, {
      items: [{ id: item.id, quantity: targetQuantity }],
      // Prorate the mid-cycle change so the agency is billed fairly for the
      // partial period (locked decision: Stripe handles proration).
      proration_behavior: "create_prorations",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    throw new Error(
      `[org-billing] failed to set subscription ${sub.id} quantity to ${targetQuantity} for org ${organizationId}: ${msg}`,
    );
  }
}

// Convenience wrapper for the server-action side-effect path: sync quantity but
// never throw — log loudly instead so a Stripe hiccup can't roll back a
// successful add/remove-client. The webhook + billing-page render reconcile
// any drift.
export async function syncOrgSubscriptionQuantitySafe(organizationId: string): Promise<void> {
  try {
    await syncOrgSubscriptionQuantity(organizationId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error(
      `[org-billing] quantity sync failed for org ${organizationId} (non-fatal; ` +
        `Stripe will reconcile on next webhook / billing-page visit): ${msg}`,
    );
  }
}

// The per-seat price id, or throw a clear error when org billing isn't
// configured. Centralised so checkout + sync share one missing-config message.
export function requireOrgSeatPrice(): string {
  const price = orgSeatPriceId();
  if (!price) {
    throw new Error(
      "[org-billing] STRIPE_PRICE_ORG_SEAT is not configured — set it to the " +
        "Stripe per-seat price id for org subscriptions.",
    );
  }
  return price;
}
