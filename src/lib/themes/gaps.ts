// Phase 6.9 — Theme-aware calendar gap detection.
//
// `findNeglectedThemes(workspaceId)` returns themes that:
//   1. Sit in the top 25% by 90-day engagement_rate AND
//   2. Have not been posted to in > 14 days AND
//   3. Are not snoozed or archived (see preferences.ts)
//
// When the workspace's `theme_gaps_enabled` flag is off we short-circuit
// to an empty list — same shape, but the caller gracefully hides the
// surfacing UI. The MIN_POSTS_FOR_RANK guard keeps cold-start workspaces
// (very few posts per theme) from misleading themselves into "neglecting"
// a one-shot theme they only ever tried once.

import { supabaseService } from "@/lib/supabase/service";
import { getThemePreferences, isThemeMuted } from "@/lib/themes/preferences";

// Detection knobs. Kept module-level so tests / the cron can read them
// to format human-friendly messages ("themes you haven't touched in 14d").
export const GAPS_ANALYSIS_WINDOW_DAYS = 90;
export const GAPS_DAYS_SINCE_THRESHOLD = 14;
export const GAPS_TOP_QUARTILE = 0.25;
export const GAPS_MIN_POSTS_FOR_RANK = 2;

export interface NeglectedTheme {
  theme: string;
  engagement_rate_30d: number;
  posts_in_window: number;
  last_posted_at: string;
  days_since_last_post: number;
  rank_percentile: number; // 0..1, where 1.0 = best theme
}

export interface FindNeglectedOptions {
  // Override the "now" anchor (used by tests so cron output is deterministic).
  now?: Date;
}

// Aggregates per-theme stats and applies the threshold. Service-role
// Supabase client throughout — RLS would block cross-workspace reads and
// the cron has no auth context anyway.
export async function findNeglectedThemes(
  workspaceId: string,
  options: FindNeglectedOptions = {},
): Promise<NeglectedTheme[]> {
  const prefs = await getThemePreferences(workspaceId);
  if (!prefs.gapsEnabled) return [];

  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - GAPS_ANALYSIS_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const svc = supabaseService();
  const { data, error } = await svc
    .from("posts")
    .select("theme, posted_at, post_metrics(engagement_rate, fetched_at)")
    .eq("workspace_id", workspaceId)
    .eq("status", "posted")
    .gte("posted_at", since)
    .not("theme", "is", null);
  if (error || !data) return [];

  type Row = {
    theme: string | null;
    posted_at: string | null;
    post_metrics: Array<{ engagement_rate: number | null; fetched_at: string }>;
  };

  // Aggregate by theme: sum/count latest-per-post engagement and track the
  // most-recent posted_at across the window.
  interface Agg {
    sum: number;
    count: number;
    lastPostedAt: string;
  }
  const byTheme = new Map<string, Agg>();
  for (const row of (data ?? []) as unknown as Row[]) {
    if (!row.theme || !row.posted_at) continue;
    const key = row.theme.trim().toLowerCase();
    if (!key) continue;
    const latest = row.post_metrics
      .slice()
      .sort((a, b) => +new Date(b.fetched_at) - +new Date(a.fetched_at))[0];
    if (!latest || latest.engagement_rate == null) continue;
    if (!Number.isFinite(latest.engagement_rate)) continue;
    const cur = byTheme.get(key) ?? { sum: 0, count: 0, lastPostedAt: row.posted_at };
    cur.sum += latest.engagement_rate;
    cur.count += 1;
    if (new Date(row.posted_at).getTime() > new Date(cur.lastPostedAt).getTime()) {
      cur.lastPostedAt = row.posted_at;
    }
    byTheme.set(key, cur);
  }

  // Drop themes with < MIN_POSTS_FOR_RANK so a one-shot theme can't claim
  // top-quartile status on a single post's metric.
  const ranked = Array.from(byTheme.entries())
    .filter(([, v]) => v.count >= GAPS_MIN_POSTS_FOR_RANK)
    .map(([theme, v]) => ({
      theme,
      engagement_rate_30d: v.sum / v.count,
      posts_in_window: v.count,
      lastPostedAt: v.lastPostedAt,
    }))
    .sort((a, b) => b.engagement_rate_30d - a.engagement_rate_30d);

  if (ranked.length === 0) return [];

  // Top quartile cutoff index. Math.max(1,…) so a workspace with 1-3
  // qualifying themes still gets the top one considered.
  const topCount = Math.max(1, Math.ceil(ranked.length * GAPS_TOP_QUARTILE));
  const winners = ranked.slice(0, topCount);

  const neglected: NeglectedTheme[] = [];
  for (let i = 0; i < winners.length; i += 1) {
    const w = winners[i]!;
    if (isThemeMuted(prefs.entries, w.theme)) continue;
    const daysSince = Math.floor(
      (now.getTime() - new Date(w.lastPostedAt).getTime()) / (24 * 60 * 60 * 1000),
    );
    if (daysSince <= GAPS_DAYS_SINCE_THRESHOLD) continue;
    neglected.push({
      theme: w.theme,
      engagement_rate_30d: w.engagement_rate_30d,
      posts_in_window: w.posts_in_window,
      last_posted_at: w.lastPostedAt,
      days_since_last_post: daysSince,
      rank_percentile: 1 - i / Math.max(1, ranked.length),
    });
  }

  // Best-engagement first; ties broken by longest gap (more neglected
  // beats more recently neglected).
  return neglected.sort((a, b) => {
    if (b.engagement_rate_30d !== a.engagement_rate_30d) {
      return b.engagement_rate_30d - a.engagement_rate_30d;
    }
    return b.days_since_last_post - a.days_since_last_post;
  });
}
