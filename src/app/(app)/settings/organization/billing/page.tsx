import Link from "next/link";
import { getAuthedUserOrRedirect, listOrganizations } from "@/lib/workspace";
import { supabaseService } from "@/lib/supabase/service";
import { TIERS, orgSeatPriceId } from "@/lib/billing/tiers";
import { billingConfigured } from "@/lib/billing/stripe";
import { OrgBillingActions } from "./org-billing-actions";

export const dynamic = "force-dynamic";

/**
 * /settings/organization/billing — the agency pays ONCE here, priced per active
 * client workspace (locked decision #1). Mirrors /settings/billing (the solo
 * page) but the subscription lives on the ORGANIZATION: quantity = number of
 * active client workspaces. Only the org owner manages billing; members see a
 * read-only summary.
 *
 * No org yet → point the user at /settings/organization to create one. Org
 * exists → show plan, subscription status, seat count, and checkout / portal
 * actions (owner only).
 */
export default async function OrgBillingPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const user = await getAuthedUserOrRedirect();
  const sp = await searchParams;
  const status = sp?.status ?? null;

  const orgs = await listOrganizations();
  const org = orgs[0] ?? null;

  if (!org) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="space-y-1">
          <p className="label-eyebrow">Settings</p>
          <h1 className="text-2xl font-semibold tracking-tight">Organization billing</h1>
        </header>
        <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
          You don&apos;t have an organization yet.{" "}
          <Link className="underline" href="/settings/organization">
            Create one
          </Link>{" "}
          to manage billing for multiple client workspaces under a single
          subscription.
        </div>
      </div>
    );
  }

  // Billing columns + live seat count via service role — uniform with the solo
  // billing page, and the seat count must be authoritative regardless of RLS.
  const svc = supabaseService();
  const { data: orgRow } = await svc
    .from("organizations")
    .select("id, plan, stripe_customer_id, stripe_subscription_id, subscription_status")
    .eq("id", org.id)
    .maybeSingle();
  const { count: clientCount } = await svc
    .from("workspaces")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", org.id);

  const seats = clientCount ?? 0;
  const isOwner = org.owner_id === user.id;
  const configured = billingConfigured() && orgSeatPriceId() !== null;
  const hasActiveSub = Boolean(orgRow?.stripe_subscription_id);
  const tier = TIERS.agency; // The org tier; clients inherit these ceilings.

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header className="space-y-1">
        <p className="label-eyebrow">Settings</p>
        <h1 className="text-2xl font-semibold tracking-tight">Organization billing</h1>
        <p className="text-sm text-muted-foreground">
          One subscription for <strong>{org.name}</strong>, priced per active
          client workspace. Adding or removing a client adjusts your bill
          automatically.
        </p>
      </header>

      {status === "success" && (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-4 text-sm">
          Subscription started. It may take a moment for the status to update here.
        </div>
      )}
      {status === "cancelled" && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
          Checkout cancelled. No charge was made.
        </div>
      )}

      {!configured && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
          <p className="font-medium">Org billing is not configured on this deployment.</p>
          <p className="mt-1 text-muted-foreground">
            Set <code>STRIPE_SECRET_KEY</code>, <code>STRIPE_WEBHOOK_SECRET</code>, and{" "}
            <code>STRIPE_PRICE_ORG_SEAT</code> (the Stripe per-seat price id for org
            subscriptions) in env.
          </p>
        </div>
      )}

      <section className="rounded-lg border p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Current plan</p>
            <p className="text-xl font-semibold">{tier.name}</p>
            {orgRow?.subscription_status && (
              <p className="text-xs text-muted-foreground">
                Subscription status:{" "}
                <span className="font-mono">{orgRow.subscription_status}</span>
              </p>
            )}
          </div>
          <div className="text-right">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Billed seats</p>
            <p className="mt-1 text-xl font-semibold">{seats}</p>
            <p className="text-xs text-muted-foreground">
              {seats === 1 ? "1 client workspace" : `${seats} client workspaces`}
              {" · "}${tier.priceMonthly}/seat/mo
            </p>
          </div>
        </div>

        <ul className="mt-5 grid gap-2 text-sm sm:grid-cols-2">
          {tier.features.map((f) => (
            <li key={f} className="flex gap-2">
              <span aria-hidden className="text-emerald-600 dark:text-emerald-500">
                ✓
              </span>
              <span>{f}</span>
            </li>
          ))}
        </ul>

        {isOwner ? (
          <div className="mt-6 border-t pt-5">
            {!configured ? (
              <p className="text-sm text-muted-foreground">
                Configure org billing (above) to start a subscription.
              </p>
            ) : hasActiveSub ? (
              <OrgBillingActions organizationId={org.id} mode="portal" />
            ) : (
              <div className="space-y-2">
                <OrgBillingActions
                  organizationId={org.id}
                  mode="checkout"
                  label={`Start subscription — ${Math.max(seats, 1)} seat${Math.max(seats, 1) === 1 ? "" : "s"}`}
                />
                <p className="text-xs text-muted-foreground">
                  You&apos;ll be billed for {Math.max(seats, 1)} seat
                  {Math.max(seats, 1) === 1 ? "" : "s"} (one per active client
                  workspace, minimum one). Add or remove clients later and the
                  quantity updates automatically.
                </p>
              </div>
            )}
          </div>
        ) : (
          <p className="mt-6 border-t pt-5 text-xs text-muted-foreground">
            Only the organization owner can manage billing.
          </p>
        )}
      </section>

      <p className="text-xs text-muted-foreground">
        Looking for your personal / solo plan?{" "}
        <Link className="underline" href="/settings/billing">
          Workspace billing
        </Link>
        .
      </p>
    </div>
  );
}
