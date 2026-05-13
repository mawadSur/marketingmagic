// Tier definitions for marketingmagic billing.
//
// Hard-coded so the app can boot without a working Stripe configuration —
// every gating helper and the /settings/billing UI imports these. The
// Stripe price IDs live in env (STRIPE_PRICE_PRO / STRIPE_PRICE_AGENCY)
// and are resolved at request time via priceIdForPlan(); never in the
// hot path so missing keys don't crash unrelated pages.

export type PlanId = "hobby" | "pro" | "agency";

export interface TierLimits {
  // -1 means unlimited.
  channels: number;
  postsPerMonth: number;
  imageGensPerMonth: number;
}

export interface Tier {
  id: PlanId;
  name: string;
  priceMonthly: number; // USD
  limits: TierLimits;
  blurb: string;
  features: string[];
}

export const TIERS: Record<PlanId, Tier> = {
  hobby: {
    id: "hobby",
    name: "Hobby",
    priceMonthly: 0,
    limits: { channels: 1, postsPerMonth: 10, imageGensPerMonth: 0 },
    blurb: "Free forever for solo creators trying it out.",
    features: [
      "1 connected channel",
      "10 generated posts / month",
      "Manual approval queue",
      "No AI image generation",
    ],
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceMonthly: 29,
    limits: { channels: -1, postsPerMonth: 200, imageGensPerMonth: 100 },
    blurb: "For one brand, all the channels, real volume.",
    features: [
      "Unlimited connected channels",
      "200 generated posts / month",
      "100 AI image generations / month",
      "Trust-mode auto-posting",
    ],
  },
  agency: {
    id: "agency",
    name: "Agency",
    priceMonthly: 99,
    limits: { channels: -1, postsPerMonth: 500, imageGensPerMonth: 500 },
    blurb: "Multi-client workspaces, higher ceilings, priority support.",
    features: [
      "Everything in Pro",
      "Multi-workspace (clients)",
      "500 generated posts / month",
      "500 AI image generations / month",
    ],
  },
};

export const PAID_PLANS: ReadonlyArray<PlanId> = ["pro", "agency"] as const;

export function tierFor(plan: string | null | undefined): Tier {
  if (plan === "pro") return TIERS.pro;
  if (plan === "agency") return TIERS.agency;
  return TIERS.hobby;
}

// Resolves a Stripe price id to a plan. Env is read lazily (no throw if
// the env var is missing — webhook handler converts to 'hobby' on unknown
// price, which mirrors what happens when a sub is cancelled).
export function planForPriceId(priceId: string | null | undefined): PlanId | null {
  if (!priceId) return null;
  if (process.env.STRIPE_PRICE_PRO && priceId === process.env.STRIPE_PRICE_PRO) return "pro";
  if (process.env.STRIPE_PRICE_AGENCY && priceId === process.env.STRIPE_PRICE_AGENCY) return "agency";
  return null;
}

export function priceIdForPlan(plan: PlanId): string | null {
  if (plan === "pro") return process.env.STRIPE_PRICE_PRO ?? null;
  if (plan === "agency") return process.env.STRIPE_PRICE_AGENCY ?? null;
  return null;
}

// YYYY-MM bucket used to key usage_counters rows.
export function currentMonthBucket(d: Date = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}
