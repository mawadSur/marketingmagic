import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { siteUrl } from "@/lib/env";
import { supabaseServer } from "@/lib/supabase/server";
import {
  stripeClient,
  billingConfigured,
  BillingNotConfiguredError,
} from "@/lib/billing/stripe";
import { orgSeatPriceId } from "@/lib/billing/tiers";
import {
  ensureOrgStripeCustomer,
  countActiveClientWorkspaces,
} from "@/lib/billing/org-subscription";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  organizationId: z.string().uuid(),
});

// Org checkout — starts the ONE per-org subscription, priced per active client
// workspace. Mirrors /api/billing/checkout (the solo path) but: (1) the
// customer + metadata are org-scoped, (2) the line-item quantity is the current
// active-client count, and (3) the only price is the org seat price. The
// webhook then writes organizations.subscription_status / plan from the
// resulting subscription.
export async function POST(req: NextRequest) {
  if (!billingConfigured()) {
    return NextResponse.json(
      { error: "Billing is not configured on this deployment." },
      { status: 503 },
    );
  }

  const seatPrice = orgSeatPriceId();
  if (!seatPrice) {
    return NextResponse.json(
      {
        error:
          "Org billing price is not configured. Set STRIPE_PRICE_ORG_SEAT in env.",
      },
      { status: 503 },
    );
  }

  let parsed: z.infer<typeof bodySchema>;
  try {
    const json = await req.json();
    const safe = bodySchema.safeParse(json);
    if (!safe.success) {
      return NextResponse.json(
        { error: safe.error.issues[0]?.message ?? "Invalid request body." },
        { status: 400 },
      );
    }
    parsed = safe.data;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  // Authn + authorization: the user must be an org ADMIN (owner OR 'admin'
  // org_membership) to manage billing — the same gate as add-client (which also
  // moves the seat count). We prove it via the user_is_org_admin(org_id) RPC
  // (SECURITY DEFINER, owner-or-'admin') under the caller's session, NOT by RLS
  // readability alone (a manager would also pass that), so a manager or
  // non-member can't start/redirect billing.
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthenticated." }, { status: 401 });
  }

  const { data: org } = await supabase
    .from("organizations")
    .select("id, owner_id")
    .eq("id", parsed.organizationId)
    .maybeSingle();
  if (!org) {
    return NextResponse.json(
      { error: "Organization not found or you are not a member." },
      { status: 403 },
    );
  }
  const { data: isAdmin, error: authzErr } = await supabase.rpc("user_is_org_admin", {
    org_id: org.id,
  });
  if (authzErr || isAdmin !== true) {
    return NextResponse.json(
      { error: "Only an organization admin can manage billing." },
      { status: 403 },
    );
  }

  try {
    const customerId = await ensureOrgStripeCustomer({
      organizationId: org.id,
      ownerEmail: user.email ?? null,
    });

    // quantity = active client workspaces, with a floor of 1 (Stripe forbids 0
    // and an agency paying for at least one seat is the expected baseline).
    const quantity = Math.max(await countActiveClientWorkspaces(org.id), 1);

    const base = siteUrl();
    const session = await stripeClient().checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: seatPrice, quantity }],
      success_url: `${base}/settings/organization/billing?status=success`,
      cancel_url: `${base}/settings/organization/billing?status=cancelled`,
      // Stamp the org id on the subscription so the webhook can resolve it even
      // before the customer→org mapping has propagated.
      subscription_data: {
        metadata: { organization_id: org.id },
      },
      metadata: { organization_id: org.id },
      allow_promotion_codes: true,
    });

    if (!session.url) {
      return NextResponse.json({ error: "Checkout session has no URL." }, { status: 500 });
    }
    return NextResponse.json({ url: session.url });
  } catch (err) {
    if (err instanceof BillingNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    const msg = err instanceof Error ? err.message : "Stripe error.";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
