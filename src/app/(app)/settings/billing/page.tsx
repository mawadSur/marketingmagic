import Link from "next/link";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseService } from "@/lib/supabase/service";
import { TIERS, tierFor, currentMonthBucket, priceIdForPlan, type PlanId } from "@/lib/billing/tiers";
import { billingConfigured } from "@/lib/billing/stripe";
import { BillingActions } from "./billing-actions";

export const dynamic = "force-dynamic";

interface UsageRow {
  posts_generated: number;
  images_generated: number;
  videos_generated: number;
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
    .select("posts_generated, images_generated, videos_generated")
    .eq("workspace_id", ws.id)
    .eq("month", month)
    .maybeSingle();
  const usage: UsageRow = {
    posts_generated: usageRow?.posts_generated ?? 0,
    images_generated: usageRow?.images_generated ?? 0,
    videos_generated: usageRow?.videos_generated ?? 0,
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
            <code>STRIPE_PRICE_PRO</code>, <code>STRIPE_PRICE_AGENCY</code>, and (optionally){" "}
            <code>STRIPE_PRICE_FOUNDER</code> in env.
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
            <UsageRow
              label="Videos"
              value={usage.videos_generated}
              limit={currentTier.limits.videosPerMonth}
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

      {/* Phase 2.6 pricing redesign — three paid tiers as the centerpiece
          (Solo / Agency / Founder) with Hobby as a quieter "or stay free"
          card at the bottom. Founder gets a "Most premium" pill + amber
          border so it reads as the anchor tier, not just "the priciest"
          option. */}
      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">Plans</h2>
          <p className="text-sm text-muted-foreground">
            Three paid tiers. Pick the one that matches how you work.
          </p>
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          {(["pro", "agency", "founder"] as PlanId[]).map((id) => {
            const tier = TIERS[id];
            const isCurrent = id === currentPlan;
            const tierPriceConfigured = priceIdForPlan(id) !== null;
            const isFounder = id === "founder";
            return (
              <div
                key={tier.id}
                className={
                  "relative flex flex-col rounded-lg border p-6 " +
                  (isCurrent ? "border-primary/60 ring-1 ring-primary/30 " : "") +
                  (isFounder && !isCurrent ? "border-amber-500/60 bg-amber-500/5 " : "")
                }
              >
                {isFounder && (
                  <span className="absolute -top-3 left-6 inline-flex items-center rounded-full border border-amber-500/60 bg-background px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400">
                    Voice-only workflow
                  </span>
                )}
                <div className="flex items-baseline justify-between">
                  <p className="text-xl font-semibold">{tier.name}</p>
                  <p className="text-base text-muted-foreground">
                    <span className="font-semibold text-foreground">
                      ${tier.priceMonthly}
                    </span>
                    /mo
                  </p>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">{tier.blurb}</p>
                <ul className="mt-4 flex-1 space-y-2 text-sm">
                  {tier.features.map((f) => (
                    <li key={f} className="flex gap-2">
                      <span aria-hidden className="text-emerald-600 dark:text-emerald-500">
                        ✓
                      </span>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-6">
                  {isCurrent ? (
                    <span className="inline-block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Current plan
                    </span>
                  ) : configured && tierPriceConfigured ? (
                    <BillingActions
                      workspaceId={ws.id}
                      mode="checkout"
                      planId={tier.id}
                      label={`Upgrade to ${tier.name}`}
                    />
                  ) : !tierPriceConfigured ? (
                    <span className="text-xs text-muted-foreground">
                      Configure <code>STRIPE_PRICE_{tier.id.toUpperCase()}</code> to enable.
                    </span>
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

        {/* Hobby as a quiet free-tier fallback. Same logic as before, just
            visually demoted so the three paid tiers are the centerpiece. */}
        <div
          className={
            "rounded-lg border p-5 " +
            (currentPlan === "hobby" ? "border-primary/60 ring-1 ring-primary/30" : "border-dashed")
          }
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-0.5">
              <p className="text-sm font-semibold">{TIERS.hobby.name} · Free</p>
              <p className="text-xs text-muted-foreground">{TIERS.hobby.blurb}</p>
            </div>
            <p className="text-xs text-muted-foreground">
              {currentPlan === "hobby"
                ? "Current plan"
                : "Cancel via Manage subscription to downgrade."}
            </p>
          </div>
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
