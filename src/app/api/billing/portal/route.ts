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

  const supabase = await supabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthenticated." }, { status: 401 });
  }

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id, stripe_customer_id")
    .eq("id", parsed.workspaceId)
    .maybeSingle();
  if (!workspace) {
    return NextResponse.json(
      { error: "Workspace not found or you are not a member." },
      { status: 403 },
    );
  }
  if (!workspace.stripe_customer_id) {
    return NextResponse.json(
      { error: "This workspace has no Stripe customer yet. Start a subscription first." },
      { status: 400 },
    );
  }

  try {
    const session = await stripeClient().billingPortal.sessions.create({
      customer: workspace.stripe_customer_id,
      return_url: `${siteUrl()}/settings/billing`,
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
