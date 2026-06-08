// Tier definitions for marketingmagic billing.
//
// Hard-coded so the app can boot without a working Stripe configuration —
// every gating helper and the /settings/billing UI imports these. The
// Stripe price IDs live in env (STRIPE_PRICE_PRO / STRIPE_PRICE_AGENCY /
// STRIPE_PRICE_FOUNDER) and are resolved at request time via priceIdForPlan();
// never in the hot path so missing keys don't crash unrelated pages.
//
// ─── OPERATOR ACTION (Blotato-competitive pricing) ──────────────────────────
// The customer-facing ladder is now Free $0 / Solo $29 / Creator $97 /
// Agency $499. The ENUM IDS DID NOT CHANGE — they are still
// hobby / pro / founder / agency — so the webhook, every DB plan row, and the
// STRIPE_PRICE_* env vars keep working without a data migration. Only the
// display name + price + limits changed.
//
// To put the new prices LIVE the operator must, in the Stripe Dashboard:
//   1. Create three new monthly recurring prices:
//        • Solo $29   → set STRIPE_PRICE_PRO     to its price id
//        • Creator $97 → set STRIPE_PRICE_FOUNDER to its price id (reuse this var)
//        • Agency $499 → set STRIPE_PRICE_AGENCY  to its price id (reuse this var)
//      (STRIPE_PRICE_ORG_SEAT — the per-seat org price — is separate; only
//       update it if the org seat price itself is changing.)
//   2. EXISTING SUBSCRIPTIONS STAY ON THEIR OLD STRIPE PRICE until the operator
//      migrates them (Stripe proration, at renewal). See
//      docs/pricing-migration-runbook.md for the exact enum→price steps. Until
//      env is updated these helpers degrade gracefully (planForPriceId returns
//      null / billingConfigured() guards the checkout UI) — no fake price ids
//      are ever invented here.

export type PlanId = "hobby" | "pro" | "agency" | "founder";

export interface TierLimits {
  // -1 means unlimited.
  channels: number;
  postsPerMonth: number;
  imageGensPerMonth: number;
  // P4: monthly cap on BYO-key video renders (MoneyPrinterTurbo). 0 means the
  // feature is off for the tier (Hobby), -1 means unlimited. Customers bring
  // their own LLM + Pexels keys, so the only cost we're metering here is our
  // orchestration + storage of the rendered mp4s — hence generous-but-finite
  // ceilings on paid tiers and zero on free.
  videosPerMonth: number;
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

// ─── "AI credits" presentation model (Blotato-competitive pricing) ──────────
//
// Blotato bundles image + video generation into a single "AI credits" number
// per tier ("Unlimited AI writing" sits alongside it). We adopt that PRESENTATION
// without changing how we METER. The backend still enforces THREE separate
// counters (posts_generated / images_generated / videos_generated) exactly as
// before — see usage.ts + limits.ts, which are untouched by this redesign. The
// only thing that changed is that the pricing UI shows ONE combined credits
// number derived from the image + video ceilings.
//
// CREDIT MAPPING (be honest about this — it's a presentation aggregate, not a
// new currency):
//
//   aiCredits(tier) = imageGensPerMonth + videosPerMonth   (a -1 in either → "unlimited")
//
// The image:video split per tier is sized so the COMBINED total lands on a
// round, Blotato-comparable headline credit number:
//   • Solo    → 1000 images + 250 videos  = 1,250 credits  (≈ Blotato Starter)
//   • Creator → 4000 images + 1000 videos = 5,000 credits
//   • Agency  → 22000 images + 6000 videos = 28,000 credits
// The split favours images (cheaper to produce) over videos; tune the per-type
// ceilings freely as long as the sum stays on the headline number.
//
// AI WRITING is now UNLIMITED on every paid tier (postsPerMonth: -1), matching
// Blotato's "Unlimited AI writing". Only Hobby keeps a finite post cap.

export const TIERS: Record<PlanId, Tier> = {
  hobby: {
    // UNCHANGED. Free forever entry tier: 1 channel, 10 posts, no image/video,
    // no voice memo. The only tier with a finite post cap.
    id: "hobby",
    name: "Free",
    priceMonthly: 0,
    limits: { channels: 1, postsPerMonth: 10, imageGensPerMonth: 0, videosPerMonth: 0, voiceMemoRecorder: false },
    blurb: "Free forever for solo creators trying it out.",
    features: [
      "1 connected channel",
      "10 generated posts / month",
      "Manual approval queue",
      "No AI image or video generation",
    ],
  },
  pro: {
    // "Solo" $29 (display name unchanged from the prior Phase 2.6 rename). The
    // enum id stays 'pro' so the Stripe webhook + every DB plan row + the
    // STRIPE_PRICE_PRO env var keep working WITHOUT a data migration; only the
    // price + limits changed for the Blotato-competitive ladder.
    //
    // Blotato-Starter-equivalent: UNLIMITED AI writing (postsPerMonth: -1) +
    // ~1,250 AI credits/mo (1000 images + 250 videos). Channels unlimited.
    id: "pro",
    name: "Solo",
    priceMonthly: 29,
    limits: { channels: -1, postsPerMonth: -1, imageGensPerMonth: 1000, videosPerMonth: 250, voiceMemoRecorder: false },
    blurb: "One brand, every channel, unlimited writing. The default for solo creators.",
    // NOTE: "Unlimited AI writing" + the AI-credits number are rendered by the
    // billing UI from the limits via aiCreditsLabel() (not duplicated here). The
    // `features` list is for the DIFFERENTIATING perks beyond the credit headline.
    features: [
      "Unlimited connected channels",
      "Trust-mode auto-posting",
      "AI images + short-form video",
    ],
  },
  agency: {
    // "Agency" $499. The enum id stays 'agency' — this is ALSO the org /
    // multi-workspace tier: org subscriptions resolve to 'agency' in
    // entitlements.ts + planForOrgPriceId, and client workspaces inherit it.
    // That semantics is unchanged. Only the price + limits moved.
    //
    // Highest-volume tier: UNLIMITED AI writing + ~28,000 AI credits/mo
    // (22000 images + 6000 videos). Multi-workspace / white-label perks stay.
    id: "agency",
    name: "Agency",
    priceMonthly: 499,
    limits: { channels: -1, postsPerMonth: -1, imageGensPerMonth: 22000, videosPerMonth: 6000, voiceMemoRecorder: false },
    blurb: "Multi-client workspaces, the highest ceilings, white-label, priority support.",
    // "Unlimited AI writing" + the AI-credits number are rendered by the billing
    // UI from the limits via aiCreditsLabel(). Keep only differentiating perks here.
    features: [
      "Everything in Creator",
      "Multi-workspace (clients) + white-label",
      "Priority support",
    ],
  },
  // "Creator" $97 — RENAMED display from "Founder" (the enum id stays 'founder'
  // so hasFounderMode/hasCompetitorWatch, the STRIPE_PRICE_FOUNDER env var, the
  // webhook, and every DB plan row keep working without a migration). This is
  // the voice-memo tier: founder ALREADY owns voiceMemoRecorder:true → Creator
  // keeps it. hasCompetitorWatch/hasFounderMode still key off id==='founder'.
  //
  // Mid tier: UNLIMITED AI writing + ~5,000 AI credits/mo (4000 images +
  // 1000 videos) + the voice-memo workflow + Competitor Watch.
  founder: {
    id: "founder",
    name: "Creator",
    priceMonthly: 97,
    limits: { channels: -1, postsPerMonth: -1, imageGensPerMonth: 4000, videosPerMonth: 1000, voiceMemoRecorder: true },
    blurb: "Voice-memo to a week of posts. For creators who'd rather talk than type.",
    // "Unlimited AI writing" + the AI-credits number are rendered by the billing
    // UI from the limits via aiCreditsLabel(). Keep only differentiating perks here.
    features: [
      "Everything in Solo",
      "Voice-memo recorder (/record) — talk for 2 minutes, get a week of posts",
      "Competitor Watch",
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

// ─── "AI credits" presentation helper ───────────────────────────────────────
//
// Derives the single Blotato-style "AI credits (images + video)" number the
// pricing UI shows from the tier's TWO underlying ceilings. THIS IS A DISPLAY
// AGGREGATE ONLY — it does NOT change metering. The backend keeps enforcing
// imageGensPerMonth and videosPerMonth as two independent counters (see
// limits.ts / usage.ts). Honestly: "credits" = images + videos combined.
//
//   • If either ceiling is unlimited (-1), the combined credits are unlimited
//     (returns Infinity), since you can't sum a finite number with "infinite".
//   • Otherwise returns imageGensPerMonth + videosPerMonth.
//
// Use aiCreditsLabel() for the human-readable string ("Unlimited" / "1,250").
export function aiCreditsFor(plan: string | null | undefined): number {
  const { imageGensPerMonth, videosPerMonth } = tierFor(plan).limits;
  if (imageGensPerMonth === -1 || videosPerMonth === -1) return Number.POSITIVE_INFINITY;
  return imageGensPerMonth + videosPerMonth;
}

// Human-readable AI-credits string for the pricing UI. "Unlimited" when the
// combined credits are infinite; otherwise the integer formatted with thousands
// separators (e.g. "1,250"). A tier with zero credits (Hobby) returns "0".
export function aiCreditsLabel(plan: string | null | undefined): string {
  const credits = aiCreditsFor(plan);
  if (!Number.isFinite(credits)) return "Unlimited";
  return credits.toLocaleString("en-US");
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

// ─── Org (agency) billing ────────────────────────────────────────────────
// Phase C: the org holds ONE Stripe subscription whose `quantity` equals the
// number of active client workspaces. It is priced on a single per-seat price
// (STRIPE_PRICE_ORG_SEAT) that is distinct from the solo plan prices above so
// the webhook can tell an org subscription apart from a solo one purely by
// price id. The org always resolves to the 'agency' plan — clients inherit the
// agency tier's ceilings (see entitlements.ts). Read lazily, like the solo
// prices, so a missing env var degrades gracefully instead of crashing.

// The per-seat price id for the org subscription, or null when unset.
export function orgSeatPriceId(): string | null {
  return process.env.STRIPE_PRICE_ORG_SEAT ?? null;
}

// True iff `priceId` is the configured org per-seat price. Used by the webhook
// to route a subscription event to the org handler vs the workspace handler.
export function isOrgSeatPrice(priceId: string | null | undefined): boolean {
  if (!priceId) return false;
  const seat = orgSeatPriceId();
  return Boolean(seat && priceId === seat);
}

// Resolves an org subscription's price id to the org's plan. The org seat price
// maps to 'agency' (the only org tier today); any other price returns null so
// the webhook can log loudly, mirroring planForPriceId for the solo path.
export function planForOrgPriceId(priceId: string | null | undefined): PlanId | null {
  if (isOrgSeatPrice(priceId)) return "agency";
  return null;
}

// YYYY-MM bucket used to key usage_counters rows.
export function currentMonthBucket(d: Date = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}
