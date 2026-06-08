// Phase 6.6 — Premium feature gates by plan.
//
// Sits alongside tiers.ts. We could fold this into the Tier shape itself,
// but a separate module keeps the "which features are premium" surface
// out of the price/limit table (which Stripe pulls from).
//
// Phase 2.6 update: the founder enum tier (displayed as "Creator", $97/mo)
// owns Competitor Watch as the marquee perk. `hasCompetitorWatch()` in `@/lib/billing/tiers`
// is the canonical capability check; this module re-exports it under the
// `isCompetitorWatchEnabled` name that the Phase 6.6 callsites already
// use, plus owns the per-channel rate-budget table that doesn't belong
// inside tiers.ts.

import { hasCompetitorWatch } from "@/lib/billing/tiers";

// Lower-cased plan-or-null guard. Workspaces with null/unrecognised plans
// fall through to Hobby treatment — fail closed. Delegates to the
// canonical Founder-tier gate so all entry points stay in sync.
export function isCompetitorWatchEnabled(plan: string | null | undefined): boolean {
  return hasCompetitorWatch(plan);
}

// Phase 6.6 — derive per-channel API rate budget from plan tier.
//
// Two layers:
//   • A global per-channel cap (calls per 15 min) keeps us from blowing
//     up the entire workspace fleet against an API.
//   • A per-workspace soft cap derived from tier — Founder gets the full
//     budget; lower tiers don't reach this code path because the
//     feature is off.
//
// Numbers are conservative defaults; tune once we see real traffic.
export const GLOBAL_RATE_CAP_PER_15MIN: Record<string, number> = {
  x: 100,
  bluesky: 300, // public API is friendlier
  linkedin: 0, // unsupported
  instagram: 0,
  threads: 0,
};

export function perWorkspaceCap(plan: string | null | undefined, channel: string): number {
  const global = GLOBAL_RATE_CAP_PER_15MIN[channel] ?? 0;
  if (!isCompetitorWatchEnabled(plan)) return 0;
  // Founder gets 100% of global per-workspace as the exclusive-perk tier.
  return global;
}
