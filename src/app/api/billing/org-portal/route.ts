import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { siteUrl } from "@/lib/env";
import { supabaseServer } from "@/lib/supabase/server";
import {
  stripeClient,
  billingConfigured,
  BillingNotConfiguredError,
} from "@/lib/billing/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  organizationId: z.string().uuid(),
});

// Org billing portal — opens the Stripe customer portal for the org's customer
// so the owner can update payment method, view invoices, or cancel. Mirrors
// /api/billing/portal (the solo path) but resolves the customer from the org,
// and is restricted to the org owner.
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

  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthenticated." }, { status: 401 });
  }

  const { data: org } = await supabase
    .from("organizations")
    .select("id, owner_id, stripe_customer_id")
    .eq("id", parsed.organizationId)
    .maybeSingle();
  if (!org) {
    return NextResponse.json(
      { error: "Organization not found or you are not a member." },
      { status: 403 },
    );
  }
  // Org-admin gate (owner OR 'admin' org_membership), proven via the
  // user_is_org_admin RPC under the caller's session — RLS readability alone
  // (which a manager passes) is not sufficient to open the billing portal.
  const { data: isAdmin, error: authzErr } = await supabase.rpc("user_is_org_admin", {
    org_id: org.id,
  });
  if (authzErr || isAdmin !== true) {
    return NextResponse.json(
      { error: "Only an organization admin can manage billing." },
      { status: 403 },
    );
  }
  if (!org.stripe_customer_id) {
    return NextResponse.json(
      { error: "This organization has no Stripe customer yet. Start a subscription first." },
      { status: 400 },
    );
  }

  try {
    const session = await stripeClient().billingPortal.sessions.create({
      customer: org.stripe_customer_id,
      return_url: `${siteUrl()}/settings/organization/billing`,
    });
    return NextResponse.json({ url: session.url });
  } catch (err) {
    if (err instanceof BillingNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    const msg = err instanceof Error ? err.message : "Stripe error.";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
