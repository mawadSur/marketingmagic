// Conversion-funnel analytics for the Magic Moment onboarding flow.
//
// V1: server-side console logging in a structured format. Vercel's log
// drain captures these; you can grep `mm.funnel` to count stages. When
// we want persistent / queryable funnels, swap the body of `track` for
// a Supabase insert into a new `analytics_events` table — the call
// sites already pass the right shape.
//
// Note on client-side analytics: the root layout already mounts
// `@vercel/analytics/next`, which gives us pageviews automatically for
// /start and /preview/[token]. The events below are server-side only,
// for funnel stages the client cannot directly observe (e.g. quota
// exceeded, scrape failure).

export type FunnelStage =
  | "landing_view"
  | "landing_submit"
  | "scrape_success"
  | "scrape_fallback"
  | "preview_generated"
  | "preview_view"
  | "preview_rate_limited"
  | "preview_cold_profile"
  | "preview_signup_cta_click"
  // PLG share loop (migration 032): a visitor minted a shareable /p/<slug> link
  // ("Share this plan"), and a (possibly different) visitor opened one.
  | "preview_shared"
  | "preview_share_view";

export interface FunnelEvent {
  stage: FunnelStage;
  /** Channel selected, if applicable. */
  channel?: string;
  /** Coarse handle bucket (hashed first 8 chars) — never raw PII. */
  handle_hash?: string;
  /** Optional ad-hoc context for the stage. */
  meta?: Record<string, string | number | boolean>;
}

/**
 * Emit a structured event line. The prefix `mm.funnel` is greppable in
 * Vercel logs. Never writes to a DB or external system in V1.
 */
export function track(event: FunnelEvent): void {
  const line = {
    evt: "mm.funnel",
    stage: event.stage,
    ts: new Date().toISOString(),
    channel: event.channel,
    handle_hash: event.handle_hash,
    ...(event.meta ?? {}),
  };
  // Single-line JSON keeps grep / log-drain happy.
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(line));
}

/** Hash a handle to a stable 8-char prefix for funnel analysis. */
export function hashHandle(handle: string): string {
  // Tiny deterministic hash — we just need a bucket id, not a crypto digest.
  let h = 5381;
  for (let i = 0; i < handle.length; i++) {
    h = ((h << 5) + h) ^ handle.charCodeAt(i);
  }
  return ("00000000" + (h >>> 0).toString(16)).slice(-8);
}
