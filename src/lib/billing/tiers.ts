// Tier definitions for marketingmagic billing.
//
// Hard-coded so the app can boot without a working Stripe configuration —
// every gating helper and the /settings/billing UI imports these. The
// Stripe price IDs live in env (STRIPE_PRICE_PRO / STRIPE_PRICE_AGENCY /
// STRIPE_PRICE_FOUNDER) and are resolved at request time via priceIdForPlan();
// never in the hot path so missing keys don't crash unrelated pages.

export type PlanId = "hobby" | "pro" | "agency" | "founder";

export interface TierLimits {
  // -1 means unlimited.
  channels: number;
  postsPerMonth: number;
  imageGensPerMonth: number;
  // Phase 2.6: gates /record (voice-memo workflow). Only Founder tier sees
  // the recorder; lower tiers see an upgrade CTA. We model it as a boolean
  // capability flag rather than a quota because Founder Mode is an entire
  // workflow, not a metered feature.
  voiceMemoRecorder: boolean;
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
    limits: { channels: 1, postsPerMonth: 10, imageGensPerMonth: 0, voiceMemoRecorder: false },
    blurb: "Free forever for solo creators trying it out.",
    features: [
      "1 connected channel",
      "10 generated posts / month",
      "Manual approval queue",
      "No AI image generation",
    ],
  },
  pro: {
    // Phase 2.6: renamed "Pro" → "Solo" in customer-facing copy so the
    // three paid tiers read as Solo / Agency / Founder. The enum id stays
    // 'pro' so the Stripe webhook + DB rows + price-id env var keep
    // working without a data migration; only the display name changed.
    id: "pro",
    name: "Solo",
    priceMonthly: 29,
    limits: { channels: -1, postsPerMonth: 200, imageGensPerMonth: 100, voiceMemoRecorder: false },
    blurb: "One brand, every channel, real volume. The default for solo creators.",
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
    limits: { channels: -1, postsPerMonth: 500, imageGensPerMonth: 500, voiceMemoRecorder: false },
    blurb: "Multi-client workspaces, higher ceilings, priority support.",
    features: [
      "Everything in Pro",
      "Multi-workspace (clients)",
      "500 generated posts / month",
      "500 AI image generations / month",
    ],
  },
  // Phase 2.6 — premium voice-memo tier. Positioned above Agency on price
  // because the value prop ("no typing, voice-only workflow") targets
  // founders/operators who'd otherwise dictate to a human social manager.
  // Quotas are intentionally higher than Pro but lower than the implicit
  // Enterprise ceiling — we want the tier to feel generous but not bottomless.
  founder: {
    id: "founder",
    name: "Founder",
    priceMonthly: 149,
    limits: { channels: -1, postsPerMonth: 1000, imageGensPerMonth: 300, voiceMemoRecorder: true },
    blurb: "Voice-memo to a week of posts. For solo operators who'd rather talk than type.",
    features: [
      "Everything in Pro",
      "Voice-memo recorder (/record) — talk for 2 minutes, get a week of posts",
      "1,000 generated posts / month",
      "300 AI image generations / month",
      "Priority support",
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

// Phase 2.6 + 6.6 capability gates. /record imports hasFounderMode;
// keeping these named helpers means call sites read clearly and we can
// swap the implementation (e.g. to read the TierLimits.voiceMemoRecorder
// flag) without touching every consumer.
export function hasFounderMode(plan: string | null | undefined): boolean {
  return tierFor(plan).id === "founder";
}

export function hasCompetitorWatch(plan: string | null | undefined): boolean {
  return tierFor(plan).id === "founder";
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

// YYYY-MM bucket used to key usage_counters rows.
export function currentMonthBucket(d: Date = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}
