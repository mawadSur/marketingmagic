// Tier definitions for marketingmagic billing.
//
// Hard-coded so the app can boot without a working Stripe configuration —
// every gating helper and the /settings/billing UI imports these. The
// Stripe price IDs live in env (STRIPE_PRICE_PRO / STRIPE_PRICE_AGENCY /
// STRIPE_PRICE_FOUNDER) and are resolved at request time via
// priceIdForPlan(); never in the hot path so missing keys don't crash
// unrelated pages.
//
// Founder tier (Phase 2.6) is the voice-first creator tier — premium price,
// single workspace, but includes exclusive entitlements (Founder Mode at
// /record and Competitor Watch from Phase 6.6). Limits + price are
// placeholders; the operator dials them in when the live price ID lands.

export type PlanId = "hobby" | "pro" | "agency" | "founder";

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
  founder: {
    id: "founder",
    name: "Founder",
    priceMonthly: 149,
    limits: { channels: -1, postsPerMonth: 500, imageGensPerMonth: 200 },
    blurb: "Voice-first workflow. Record a memo, ship a week of posts.",
    features: [
      "Founder Mode — voice memo to a week of posts (no typing)",
      "Competitor Watch — daily intel on accounts you pick",
      "500 generated posts / month",
      "200 AI image generations / month",
      "Everything in Pro",
    ],
  },
};

export const PAID_PLANS: ReadonlyArray<PlanId> = ["pro", "agency", "founder"] as const;

export function tierFor(plan: string | null | undefined): Tier {
  if (plan === "pro") return TIERS.pro;
  if (plan === "agency") return TIERS.agency;
  if (plan === "founder") return TIERS.founder;
  return TIERS.hobby;
}

// Resolves a Stripe price id to a plan. Env is read lazily (no throw if
// the env var is missing — webhook handler converts to 'hobby' on unknown
// price, which mirrors what happens when a sub is cancelled).
export function planForPriceId(priceId: string | null | undefined): PlanId | null {
  if (!priceId) return null;
  if (process.env.STRIPE_PRICE_PRO && priceId === process.env.STRIPE_PRICE_PRO) return "pro";
  if (process.env.STRIPE_PRICE_AGENCY && priceId === process.env.STRIPE_PRICE_AGENCY) return "agency";
  if (process.env.STRIPE_PRICE_FOUNDER && priceId === process.env.STRIPE_PRICE_FOUNDER) return "founder";
  return null;
}

export function priceIdForPlan(plan: PlanId): string | null {
  if (plan === "pro") return process.env.STRIPE_PRICE_PRO ?? null;
  if (plan === "agency") return process.env.STRIPE_PRICE_AGENCY ?? null;
  if (plan === "founder") return process.env.STRIPE_PRICE_FOUNDER ?? null;
  return null;
}

// Entitlement gates. Cheap boolean checks consumed by feature mounts
// (/record, /competitors) and by the planner if it needs to vary behavior
// per tier. Implemented as functions, not Tier.entitlements fields, so the
// gate set stays in one file rather than duplicating across TIERS entries —
// any tier could grow into Founder-grade entitlements without re-shipping
// the limit table.
//
// Default policy: Founder Mode and Competitor Watch are Founder-only. We
// keep Agency out of these on purpose — Agency is the multi-client tier
// (different value prop), Founder is the voice-first solo creator tier.
// If the user later wants Agency to inherit Founder entitlements, flip a
// single line here rather than weaving tier checks across call sites.
export function hasFounderMode(plan: string | null | undefined): boolean {
  return tierFor(plan).id === "founder";
}

export function hasCompetitorWatch(plan: string | null | undefined): boolean {
  return tierFor(plan).id === "founder";
}

// YYYY-MM bucket used to key usage_counters rows.
export function currentMonthBucket(d: Date = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}
