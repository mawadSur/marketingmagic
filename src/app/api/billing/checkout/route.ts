import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { siteUrl } from "@/lib/env";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import {
  stripeClient,
  billingConfigured,
  BillingNotConfiguredError,
} from "@/lib/billing/stripe";
import { priceIdForPlan, type PlanId } from "@/lib/billing/tiers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  planId: z.enum(["pro", "agency"]),
  workspaceId: z.string().uuid(),
});

export async function POST(req: NextRequest) {
  if (!billingConfigured()) {
    return NextResponse.json(
      { error: "Billing is not configured on this deployment." },
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

  // Authn + workspace membership check via RLS — supabaseServer() carries the
  // user's session cookie and `workspaces` SELECT is gated by owner_id =
  // auth.uid(), so a successful fetch implies membership.
  const supabase = await supabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthenticated." }, { status: 401 });
  }

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id, name, stripe_customer_id")
    .eq("id", parsed.workspaceId)
    .maybeSingle();
  if (!workspace) {
    return NextResponse.json(
      { error: "Workspace not found or you are not a member." },
      { status: 403 },
    );
  }

  const planId = parsed.planId as PlanId;
  const priceId = priceIdForPlan(planId);
  if (!priceId) {
    return NextResponse.json(
      { error: `No Stripe price configured for plan "${planId}".` },
      { status: 500 },
    );
  }

  const stripe = stripeClient();

  // Reuse existing customer if we already created one for this workspace.
  // Otherwise create one and persist the id with service role (the
  // workspace row's RLS update policy lets the owner update, but using
  // service role keeps the path uniform whether we're reusing or creating).
  let customerId = workspace.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email ?? undefined,
      name: workspace.name,
      metadata: {
        workspace_id: workspace.id,
        user_id: user.id,
      },
    });
    customerId = customer.id;
    const svc = supabaseService();
    await svc
      .from("workspaces")
      .update({ stripe_customer_id: customerId })
      .eq("id", workspace.id);
  }

  const base = siteUrl();
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${base}/settings/billing?status=success`,
      cancel_url: `${base}/settings/billing?status=cancelled`,
      // Surface workspace context on the resulting subscription so the
      // webhook handler can find the workspace even before the customer
      // mapping is fully propagated.
      subscription_data: {
        metadata: {
          workspace_id: workspace.id,
        },
      },
      metadata: {
        workspace_id: workspace.id,
      },
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
