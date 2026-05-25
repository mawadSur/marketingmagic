import { NextResponse, type NextRequest } from "next/server";
import type Stripe from "stripe";
import { serverEnv } from "@/lib/env";
import { supabaseService } from "@/lib/supabase/service";
import { stripeClient, BillingNotConfiguredError } from "@/lib/billing/stripe";
import { planForPriceId, type PlanId } from "@/lib/billing/tiers";

// Stripe webhook endpoint. The Stripe Node SDK's constructEvent() works in
// the Next.js Node runtime as long as we hand it the RAW body (NOT parsed
// JSON), so we read req.text() ourselves and skip any middleware parsing.
//
// Idempotency: each event handler resolves to the same final state given
// the same input — re-delivery is safe. We also de-dupe on event.id at the
// top so we never re-process a successfully-handled event.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Lightweight in-memory dedupe to short-circuit retried events within a
// single instance. The strong dedupe is "settings are idempotent"; this is
// just a perf optimisation and a safety net against Stripe's at-least-once
// retry semantics.
const seenEventIds = new Set<string>();

export async function POST(req: NextRequest) {
  const env = serverEnv();
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return NextResponse.json(
      { error: "STRIPE_WEBHOOK_SECRET not configured." },
      { status: 503 },
    );
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing stripe-signature header." }, { status: 400 });
  }

  const raw = await req.text();

  let event: Stripe.Event;
  try {
    event = stripeClient().webhooks.constructEvent(raw, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    if (err instanceof BillingNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    const msg = err instanceof Error ? err.message : "Bad signature";
    return NextResponse.json({ error: `Webhook verification failed: ${msg}` }, { status: 400 });
  }

  if (seenEventIds.has(event.id)) {
    return NextResponse.json({ received: true, deduped: true });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutSessionCompleted(event.data.object as Stripe.Checkout.Session);
        break;
      case "customer.subscription.created":
      case "customer.subscription.updated":
        await handleSubscriptionUpsert(event.data.object as Stripe.Subscription);
        break;
      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;
      default:
        // Other events (invoice.*, payment_intent.*) are not actionable for
        // plan state right now. We acknowledge them so Stripe stops retrying.
        break;
    }
    seenEventIds.add(event.id);
    return NextResponse.json({ received: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Handler error";
    // Surface a 500 so Stripe retries. Don't add to seenEventIds.
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// Resolve the workspace from any of the identifiers that might be on a
// Stripe event payload. We try (in order): metadata.workspace_id (most
// reliable; we set this on Checkout + Subscription creation), then the
// customer id which we mirror onto workspaces at Checkout time.
async function resolveWorkspaceId(args: {
  metadataWorkspaceId?: string | null;
  customerId?: string | null;
}): Promise<string | null> {
  if (args.metadataWorkspaceId) return args.metadataWorkspaceId;
  if (!args.customerId) return null;
  const svc = supabaseService();
  const { data } = await svc
    .from("workspaces")
    .select("id")
    .eq("stripe_customer_id", args.customerId)
    .maybeSingle();
  return data?.id ?? null;
}

function extractPriceId(subscription: Stripe.Subscription): string | null {
  const item = subscription.items?.data?.[0];
  return item?.price?.id ?? null;
}

async function applySubscriptionState(args: {
  workspaceId: string;
  subscription: Stripe.Subscription | null;
  fallbackPlan?: PlanId;
}): Promise<void> {
  const svc = supabaseService();
  const sub = args.subscription;

  // No subscription (cancelled/deleted) → back to hobby.
  if (!sub) {
    await svc
      .from("workspaces")
      .update({
        plan: args.fallbackPlan ?? "hobby",
        stripe_subscription_id: null,
        subscription_status: "canceled",
      })
      .eq("id", args.workspaceId);
    return;
  }

  const priceId = extractPriceId(sub);
  const planFromPrice = planForPriceId(priceId);

  // Loud warning when the price doesn't map to a known plan. This is the
  // exact silent-failure path that left a paid Founder customer stuck on
  // hobby (the webhook returned 200, the workspace stayed at hobby, the
  // user couldn't connect more than one channel). Log so the operator can
  // see the unmatched price ID in Vercel logs and fix the env vars.
  if (
    priceId &&
    !planFromPrice &&
    sub.status !== "canceled" &&
    sub.status !== "incomplete_expired"
  ) {
    console.error(
      `[stripe-webhook] price ${priceId} did not match any STRIPE_PRICE_* env var. ` +
        `Subscription ${sub.id} for workspace ${args.workspaceId} is being downgraded to hobby. ` +
        `Fix: set STRIPE_PRICE_PRO / STRIPE_PRICE_AGENCY / STRIPE_PRICE_FOUNDER on Vercel to ` +
        `match the actual Stripe price ids, then re-run the subscription event from Stripe Dashboard.`,
    );
  }

  // If the subscription is fully canceled, force the plan back to hobby
  // even if the price still resolves — the customer no longer pays.
  const effectivePlan: PlanId =
    sub.status === "canceled" || sub.status === "incomplete_expired"
      ? "hobby"
      : (planFromPrice ?? args.fallbackPlan ?? "hobby");

  await svc
    .from("workspaces")
    .update({
      plan: effectivePlan,
      stripe_customer_id: typeof sub.customer === "string" ? sub.customer : sub.customer?.id,
      stripe_subscription_id: sub.id,
      subscription_status: sub.status,
    })
    .eq("id", args.workspaceId);
}

async function handleCheckoutSessionCompleted(session: Stripe.Checkout.Session): Promise<void> {
  const customerId =
    typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;
  const metadataWorkspaceId = (session.metadata?.workspace_id as string | undefined) ?? null;

  const workspaceId = await resolveWorkspaceId({ metadataWorkspaceId, customerId });
  if (!workspaceId) {
    // Unknown workspace — ack and move on so Stripe doesn't retry forever.
    return;
  }

  // Pull the actual subscription so we resolve the plan from a fresh price
  // rather than trusting checkout's line items snapshot.
  let subscription: Stripe.Subscription | null = null;
  if (typeof session.subscription === "string") {
    subscription = await stripeClient().subscriptions.retrieve(session.subscription);
  } else if (session.subscription) {
    subscription = session.subscription;
  }

  await applySubscriptionState({ workspaceId, subscription });
}

async function handleSubscriptionUpsert(subscription: Stripe.Subscription): Promise<void> {
  const customerId =
    typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
  const metadataWorkspaceId =
    (subscription.metadata?.workspace_id as string | undefined) ?? null;
  const workspaceId = await resolveWorkspaceId({ metadataWorkspaceId, customerId });
  if (!workspaceId) return;
  await applySubscriptionState({ workspaceId, subscription });
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
  const customerId =
    typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
  const metadataWorkspaceId =
    (subscription.metadata?.workspace_id as string | undefined) ?? null;
  const workspaceId = await resolveWorkspaceId({ metadataWorkspaceId, customerId });
  if (!workspaceId) return;
  await applySubscriptionState({ workspaceId, subscription: null });
}
