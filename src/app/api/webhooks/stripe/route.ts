import { NextResponse, type NextRequest } from "next/server";
import type Stripe from "stripe";
import { serverEnv } from "@/lib/env";
import { supabaseService } from "@/lib/supabase/service";
import { stripeClient, BillingNotConfiguredError } from "@/lib/billing/stripe";
import { planForPriceId, isOrgSeatPrice, type PlanId } from "@/lib/billing/tiers";

// Stripe webhook endpoint. The Stripe Node SDK's constructEvent() works in
// the Next.js Node runtime as long as we hand it the RAW body (NOT parsed
// JSON), so we read req.text() ourselves and skip any middleware parsing.
//
// Idempotency: each event handler resolves to the same final state given
// the same input — re-delivery is safe. We also de-dupe on event.id at the
// top so we never re-process a successfully-handled event. The dedupe check
// is TWO-TIER for performance: an in-memory Set (fast-path L1 cache within
// this instance) backed by the durable stripe_events table (DB is the source
// of truth, survives cold starts + shared across lambda instances).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Lightweight in-memory dedupe to short-circuit retried events within a
// single instance (L1 cache). The durable DB check (below) is the source of
// truth; this Set is a perf optimisation only.
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

  // L1 cache: if we've already seen this event_id in this instance, skip early.
  if (seenEventIds.has(event.id)) {
    return NextResponse.json({ received: true, deduped: true });
  }

  // DURABLE dedupe: attempt to INSERT the event_id into stripe_events. If it
  // already exists (conflict on PK), this is a re-delivered event we already
  // processed → ack 200 without re-running the handler.
  const svc = supabaseService();
  const { error: insertError } = await svc
    .from("stripe_events")
    .insert({ event_id: event.id, type: event.type });

  if (insertError) {
    // A PK conflict (code 23505) means this event_id already exists in the DB
    // → we processed it before (possibly in another lambda instance, or before
    // a cold start). Ack 200 to stop Stripe retrying; don't re-run the handler.
    if (insertError.code === "23505") {
      // Also populate the in-memory set so future retries on this instance
      // short-circuit without hitting the DB.
      seenEventIds.add(event.id);
      return NextResponse.json({ received: true, deduped: true });
    }
    // Any other DB error (e.g. connection failure, permission denied) should
    // fail the request so Stripe retries → don't populate seenEventIds.
    throw new Error(
      `[stripe-webhook] failed to insert event ${event.id} into stripe_events: ${insertError.message}`,
    );
  }

  // NEW event (INSERT succeeded) → the event_id is now durably recorded. Run the
  // handler. CRITICAL: the dedupe row means "successfully processed", NOT merely
  // "received" — so if the handler throws we DELETE the row in the catch below,
  // letting Stripe's retry actually re-run the handler. Leaving the row would
  // permanently swallow a transiently-failed billing event (the retry would hit
  // the PK conflict and ack 200 without ever processing it). The window between
  // INSERT and a same-event concurrent delivery is tiny; Stripe rarely fans a
  // single event to two instances simultaneously, and a double-run is idempotent
  // anyway — so we optimise for "never silently lose a billing event".

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
    // Handler succeeded → populate the in-memory set (L1 cache) so future
    // retries on this instance short-circuit without hitting the DB. The DB
    // row already exists (we INSERTed it above), so this is just a perf win.
    seenEventIds.add(event.id);
    return NextResponse.json({ received: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Handler error";
    // Handler failed → roll back the dedupe row so Stripe's retry RE-RUNS the
    // handler (the row records success, not receipt). Without this delete, the
    // retry would hit the PK conflict and ack 200, permanently dropping a
    // failed billing event. We don't touch seenEventIds (never populated for a
    // failed event). Best-effort delete: if it fails we still 500 (Stripe
    // retries), and worst case a stuck row is one manual replay from the
    // dashboard — strictly better than silently swallowing the event.
    const { error: delError } = await svc
      .from("stripe_events")
      .delete()
      .eq("event_id", event.id);
    if (delError) {
      console.error(
        `[stripe-webhook] handler failed for ${event.id} AND dedupe-row rollback failed: ${delError.message}. Manual replay may be needed.`,
      );
    }
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

// ─── Org (agency) subscription handling ───────────────────────────────────
// Phase C: an org holds ONE subscription priced per active client workspace.
// A subscription event belongs to an ORG (not a workspace) when any of:
//   * subscription.metadata.organization_id is set (we stamp this at checkout),
//   * its price is the configured org seat price, or
//   * its customer id maps to an organizations row.
// We check those signals and, when matched, route to the org handler which
// writes organizations.subscription_status / plan instead of a workspace.

// Resolve an organization id from a subscription's identifiers. Mirrors
// resolveWorkspaceId: metadata first (most reliable), then the customer id we
// mirror onto organizations at checkout time.
async function resolveOrganizationId(args: {
  metadataOrganizationId?: string | null;
  customerId?: string | null;
}): Promise<string | null> {
  if (args.metadataOrganizationId) return args.metadataOrganizationId;
  if (!args.customerId) return null;
  const svc = supabaseService();
  const { data } = await svc
    .from("organizations")
    .select("id")
    .eq("stripe_customer_id", args.customerId)
    .maybeSingle();
  return data?.id ?? null;
}

// True iff this subscription should be handled as an org subscription. Checks
// the cheap signals (metadata, price) first; only falls back to a DB lookup by
// customer id when neither is conclusive.
async function isOrgSubscription(subscription: Stripe.Subscription): Promise<boolean> {
  if (subscription.metadata?.organization_id) return true;
  if (isOrgSeatPrice(extractPriceId(subscription))) return true;
  const customerId =
    typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
  const orgId = await resolveOrganizationId({ customerId });
  return orgId != null;
}

// Apply an org subscription's state to the organizations row: the org's
// subscription_status drives whether inherited client workspaces keep the
// agency plan (see entitlements.ts). The org always resolves to the 'agency'
// plan while the subscription pays; a fully-cancelled sub drops it to 'hobby'
// so inherited clients lose agency ceilings.
async function applyOrgSubscriptionState(args: {
  organizationId: string;
  subscription: Stripe.Subscription | null;
}): Promise<void> {
  const svc = supabaseService();
  const sub = args.subscription;

  // No subscription (cancelled/deleted) → org back to hobby, status canceled.
  if (!sub) {
    const { error } = await svc
      .from("organizations")
      .update({
        plan: "hobby",
        stripe_subscription_id: null,
        subscription_status: "canceled",
      })
      .eq("id", args.organizationId);
    if (error) {
      throw new Error(
        `[stripe-webhook] failed to clear plan on organization ${args.organizationId}: ${error.message}`,
      );
    }
    return;
  }

  const priceId = extractPriceId(sub);

  // Loud warning when an org subscription's price isn't the configured org seat
  // price — same silent-failure class as the workspace path. The org would be
  // downgraded to hobby and every client workspace would lose agency ceilings,
  // so make the unmatched price id visible in Vercel logs.
  if (
    priceId &&
    !isOrgSeatPrice(priceId) &&
    sub.status !== "canceled" &&
    sub.status !== "incomplete_expired"
  ) {
    console.error(
      `[stripe-webhook] org subscription ${sub.id} (org ${args.organizationId}) has price ` +
        `${priceId} which is not STRIPE_PRICE_ORG_SEAT. The org is being downgraded to hobby, ` +
        `which drops every client workspace to hobby ceilings. Fix: set STRIPE_PRICE_ORG_SEAT ` +
        `on Vercel to match the org per-seat price id, then re-run the event from the Stripe Dashboard.`,
    );
  }

  // A paying org subscription → agency plan. Canceled/expired → hobby even if
  // the price still resolves, mirroring the workspace path.
  const effectivePlan: PlanId =
    sub.status === "canceled" || sub.status === "incomplete_expired"
      ? "hobby"
      : isOrgSeatPrice(priceId)
        ? "agency"
        : "hobby";

  const { error } = await svc
    .from("organizations")
    .update({
      plan: effectivePlan,
      stripe_customer_id: typeof sub.customer === "string" ? sub.customer : sub.customer?.id,
      stripe_subscription_id: sub.id,
      subscription_status: sub.status,
    })
    .eq("id", args.organizationId);
  if (error) {
    throw new Error(
      `[stripe-webhook] failed to update organization ${args.organizationId} to plan=${effectivePlan} (sub ${sub.id}, status ${sub.status}): ${error.message}`,
    );
  }
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
    const { error } = await svc
      .from("workspaces")
      .update({
        plan: args.fallbackPlan ?? "hobby",
        stripe_subscription_id: null,
        subscription_status: "canceled",
      })
      .eq("id", args.workspaceId);
    if (error) {
      throw new Error(
        `[stripe-webhook] failed to clear plan on workspace ${args.workspaceId}: ${error.message}`,
      );
    }
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
        `Fix: set STRIPE_PRICE_PRO / STRIPE_PRICE_AGENCY / STRIPE_PRICE_CREATOR on Vercel to ` +
        `match the actual Stripe price ids, then re-run the subscription event from Stripe Dashboard.`,
    );
  }

  // If the subscription is fully canceled, force the plan back to hobby
  // even if the price still resolves — the customer no longer pays.
  const effectivePlan: PlanId =
    sub.status === "canceled" || sub.status === "incomplete_expired"
      ? "hobby"
      : (planFromPrice ?? args.fallbackPlan ?? "hobby");

  const { error } = await svc
    .from("workspaces")
    .update({
      plan: effectivePlan,
      stripe_customer_id: typeof sub.customer === "string" ? sub.customer : sub.customer?.id,
      stripe_subscription_id: sub.id,
      subscription_status: sub.status,
    })
    .eq("id", args.workspaceId);
  // Surface DB errors (e.g. plan CHECK violations) instead of swallowing
  // them — without throwing here, Stripe sees 200 and won't retry, and the
  // workspace silently stays on its previous plan. This is the bug that hid
  // the missing 'founder' CHECK constraint added in migration 025.
  if (error) {
    throw new Error(
      `[stripe-webhook] failed to update workspace ${args.workspaceId} to plan=${effectivePlan} (sub ${sub.id}, status ${sub.status}): ${error.message}`,
    );
  }
}

async function handleCheckoutSessionCompleted(session: Stripe.Checkout.Session): Promise<void> {
  const customerId =
    typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;

  // Pull the actual subscription so we resolve the plan from a fresh price
  // rather than trusting checkout's line items snapshot.
  let subscription: Stripe.Subscription | null = null;
  if (typeof session.subscription === "string") {
    subscription = await stripeClient().subscriptions.retrieve(session.subscription);
  } else if (session.subscription) {
    subscription = session.subscription;
  }

  // Org checkout stamps metadata.organization_id on both the session and the
  // subscription; route those to the org handler. We trust the session metadata
  // first (set on org-checkout), then fall back to inspecting the subscription.
  const metadataOrganizationId =
    (session.metadata?.organization_id as string | undefined) ?? null;
  if (metadataOrganizationId || (subscription && (await isOrgSubscription(subscription)))) {
    const organizationId = await resolveOrganizationId({
      metadataOrganizationId,
      customerId,
    });
    if (!organizationId) return; // Unknown org — ack so Stripe stops retrying.
    await applyOrgSubscriptionState({ organizationId, subscription });
    return;
  }

  const metadataWorkspaceId = (session.metadata?.workspace_id as string | undefined) ?? null;
  const workspaceId = await resolveWorkspaceId({ metadataWorkspaceId, customerId });
  if (!workspaceId) {
    // Unknown workspace — ack and move on so Stripe doesn't retry forever.
    return;
  }

  await applySubscriptionState({ workspaceId, subscription });
}

async function handleSubscriptionUpsert(subscription: Stripe.Subscription): Promise<void> {
  const customerId =
    typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;

  if (await isOrgSubscription(subscription)) {
    const metadataOrganizationId =
      (subscription.metadata?.organization_id as string | undefined) ?? null;
    const organizationId = await resolveOrganizationId({ metadataOrganizationId, customerId });
    if (!organizationId) return;
    await applyOrgSubscriptionState({ organizationId, subscription });
    return;
  }

  const metadataWorkspaceId =
    (subscription.metadata?.workspace_id as string | undefined) ?? null;
  const workspaceId = await resolveWorkspaceId({ metadataWorkspaceId, customerId });
  if (!workspaceId) return;
  await applySubscriptionState({ workspaceId, subscription });
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
  const customerId =
    typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;

  if (await isOrgSubscription(subscription)) {
    const metadataOrganizationId =
      (subscription.metadata?.organization_id as string | undefined) ?? null;
    const organizationId = await resolveOrganizationId({ metadataOrganizationId, customerId });
    if (!organizationId) return;
    await applyOrgSubscriptionState({ organizationId, subscription: null });
    return;
  }

  const metadataWorkspaceId =
    (subscription.metadata?.workspace_id as string | undefined) ?? null;
  const workspaceId = await resolveWorkspaceId({ metadataWorkspaceId, customerId });
  if (!workspaceId) return;
  await applySubscriptionState({ workspaceId, subscription: null });
}
