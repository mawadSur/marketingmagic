import Link from "next/link";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseService } from "@/lib/supabase/service";
import { TIERS, tierFor, currentMonthBucket, type PlanId } from "@/lib/billing/tiers";
import { billingConfigured } from "@/lib/billing/stripe";
import { BillingActions } from "./billing-actions";

export const dynamic = "force-dynamic";

interface UsageRow {
  posts_generated: number;
  images_generated: number;
}

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const ws = await getActiveWorkspaceOrRedirect();
  const sp = await searchParams;
  const status = sp?.status ?? null;

  // Pull the workspace row through service-role so we get the billing
  // columns even though the active-workspace cookie read used the standard
  // server client. The RLS policy already lets owners read their own row;
  // service-role is overkill but uniform with the rest of billing.
  const svc = supabaseService();
  const { data: wsRow } = await svc
    .from("workspaces")
    .select("id, plan, stripe_customer_id, stripe_subscription_id, subscription_status")
    .eq("id", ws.id)
    .maybeSingle();

  const month = currentMonthBucket();
  const { data: usageRow } = await svc
    .from("usage_counters")
    .select("posts_generated, images_generated")
    .eq("workspace_id", ws.id)
    .eq("month", month)
    .maybeSingle();
  const usage: UsageRow = {
    posts_generated: usageRow?.posts_generated ?? 0,
    images_generated: usageRow?.images_generated ?? 0,
  };

  const currentPlan = (wsRow?.plan ?? "hobby") as PlanId;
  const currentTier = tierFor(currentPlan);
  const hasActiveSub = Boolean(wsRow?.stripe_subscription_id);
  const configured = billingConfigured();

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="text-sm text-muted-foreground">
          Manage your subscription, see usage, and upgrade to higher limits.
        </p>
      </header>

      {status === "success" && (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-4 text-sm">
          Subscription started. It may take a moment for the plan to update here.
        </div>
      )}
      {status === "cancelled" && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
          Checkout cancelled. No charge was made.
        </div>
      )}

      {!configured && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
          <p className="font-medium">Stripe is not configured on this deployment.</p>
          <p className="mt-1 text-muted-foreground">
            Set <code>STRIPE_SECRET_KEY</code>, <code>STRIPE_WEBHOOK_SECRET</code>,{" "}
            <code>STRIPE_PRICE_PRO</code>, and <code>STRIPE_PRICE_AGENCY</code> in env.
          </p>
        </div>
      )}

      <section className="rounded-lg border p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Current plan</p>
            <p className="mt-1 text-xl font-semibold">{currentTier.name}</p>
            {wsRow?.subscription_status && (
              <p className="text-xs text-muted-foreground">
                Subscription status: <span className="font-mono">{wsRow.subscription_status}</span>
              </p>
            )}
          </div>
          <div className="text-right">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Usage · {month}</p>
            <UsageRow
              label="Posts generated"
              value={usage.posts_generated}
              limit={currentTier.limits.postsPerMonth}
            />
            <UsageRow
              label="AI images"
              value={usage.images_generated}
              limit={currentTier.limits.imageGensPerMonth}
            />
          </div>
        </div>
        {hasActiveSub && configured && (
          <div className="mt-4 border-t pt-4">
            <BillingActions
              workspaceId={ws.id}
              mode="portal"
            />
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">Plans</h2>
        <div className="grid gap-4 md:grid-cols-3">
          {(Object.values(TIERS)).map((tier) => {
            const isCurrent = tier.id === currentPlan;
            return (
              <div
                key={tier.id}
                className={
                  "rounded-lg border p-5 " +
                  (isCurrent ? "border-primary/60 ring-1 ring-primary/30" : "")
                }
              >
                <div className="flex items-baseline justify-between">
                  <p className="text-lg font-semibold">{tier.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {tier.priceMonthly === 0 ? "Free" : `$${tier.priceMonthly}/mo`}
                  </p>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{tier.blurb}</p>
                <ul className="mt-3 space-y-1 text-sm">
                  {tier.features.map((f) => (
                    <li key={f}>· {f}</li>
                  ))}
                </ul>
                <div className="mt-4">
                  {isCurrent ? (
                    <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Current plan
                    </span>
                  ) : tier.id === "hobby" ? (
                    <span className="text-xs text-muted-foreground">
                      Cancel via Manage subscription to downgrade.
                    </span>
                  ) : configured ? (
                    <BillingActions
                      workspaceId={ws.id}
                      mode="checkout"
                      planId={tier.id}
                      label={`Upgrade to ${tier.name}`}
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      Billing not configured.
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <p className="text-xs text-muted-foreground">
        Need a custom plan? <Link className="underline" href="mailto:support@marketingmagic.app">Contact us</Link>.
      </p>
    </div>
  );
}

function UsageRow({ label, value, limit }: { label: string; value: number; limit: number }) {
  const display = limit === -1 ? `${value} / ∞` : `${value} / ${limit}`;
  const over = limit !== -1 && value >= limit && limit !== 0;
  return (
    <p className={"text-sm " + (over ? "text-destructive" : "")}>
      <span className="text-muted-foreground">{label}:</span>{" "}
      <span className="font-medium">{display}</span>
    </p>
  );
}
