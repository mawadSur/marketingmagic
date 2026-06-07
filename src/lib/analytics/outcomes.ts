// Outcome Loop MVP (Bet 1) — revenue-ranked theme analytics.
//
// The Bayesian theme engine (themes.ts) ranks themes by ENGAGEMENT. This module
// ranks them by the thing engagement is a proxy for: self-reported BUSINESS
// OUTCOMES. It joins post_outcomes → the post's theme, then per theme:
//   • counts outcomes (and breaks them down by type),
//   • sums value_cents (revenue, where the user supplied a dollar amount),
// and returns the themes sorted by revenue first, then by outcome count.
//
// COLD START is a first-class result, not an edge case: a brand-new workspace
// has zero outcomes, and the analytics page must say so explicitly rather than
// render an empty table. `computeThemeOutcomes` returns { hasOutcomes: false }
// for that case so the caller can branch on a single boolean.
//
// SCOPE: self-report only. No UTM / short-link / pixel ingestion — deferred
// phase 2. Every value here traces back to a human "Mark outcome" assertion.
//
// Pure-ish: one DB read (the join below); the roll-up is in-memory. No new deps.

import { supabaseService } from "@/lib/supabase/service";
import type { PostOutcomeType } from "@/lib/db/types";

// Per-theme roll-up of outcomes. `revenue_cents` is the exact integer sum of
// the value_cents the user attached; outcomes with no dollar amount still count
// toward `outcomes` but contribute 0 to revenue.
export interface ThemeOutcomeStat {
  // Null theme (legacy / single-channel posts) is bucketed under this sentinel
  // so untagged posts that drove outcomes still surface (as "Untagged").
  tag: string;
  outcomes: number;
  revenue_cents: number;
  // How many of the `outcomes` carried a dollar amount. Lets the UI show
  // "$X across N of M outcomes" without re-deriving it.
  outcomes_with_value: number;
  // Per-type counts so the UI can render a compact breakdown chip row.
  by_type: Record<PostOutcomeType, number>;
}

export interface ThemeOutcomeReport {
  // The single boolean the cold-start empty state branches on.
  hasOutcomes: boolean;
  // Per-theme rows, sorted revenue desc then outcome-count desc. Empty on cold
  // start.
  themes: ThemeOutcomeStat[];
  // Workspace totals for a headline strip above the table.
  totalOutcomes: number;
  totalRevenueCents: number;
}

// Sentinel theme label for outcomes attributed to posts with no theme set.
export const UNTAGGED_THEME = "Untagged";

interface OutcomeJoinRow {
  outcome_type: PostOutcomeType;
  value_cents: number | null;
  posts: { theme: string | null } | null;
}

function emptyByType(): Record<PostOutcomeType, number> {
  return { lead: 0, sale: 0, signup: 0, booking: 0, other: 0 };
}

export async function computeThemeOutcomes(
  workspaceId: string,
): Promise<ThemeOutcomeReport> {
  const svc = supabaseService();

  // Join each outcome to its post's theme. workspace_id is filtered on the
  // outcome row itself (it carries its own column) AND the inner join keeps
  // only outcomes whose post still exists. Generous limit — outcome volume is
  // human-entered and low.
  const { data, error } = await svc
    .from("post_outcomes")
    .select("outcome_type, value_cents, posts!inner(theme)")
    .eq("workspace_id", workspaceId)
    .limit(5000);

  if (error || !data || data.length === 0) {
    return { hasOutcomes: false, themes: [], totalOutcomes: 0, totalRevenueCents: 0 };
  }

  const rows = data as unknown as OutcomeJoinRow[];

  const byTheme = new Map<string, ThemeOutcomeStat>();
  let totalOutcomes = 0;
  let totalRevenueCents = 0;

  for (const row of rows) {
    const tag = row.posts?.theme ?? UNTAGGED_THEME;
    const value = typeof row.value_cents === "number" ? row.value_cents : null;

    const stat =
      byTheme.get(tag) ??
      {
        tag,
        outcomes: 0,
        revenue_cents: 0,
        outcomes_with_value: 0,
        by_type: emptyByType(),
      };

    stat.outcomes += 1;
    stat.by_type[row.outcome_type] += 1;
    if (value !== null) {
      stat.revenue_cents += value;
      stat.outcomes_with_value += 1;
      totalRevenueCents += value;
    }
    byTheme.set(tag, stat);
    totalOutcomes += 1;
  }

  // Revenue first (the headline ranking), then raw outcome count as a
  // tie-breaker so value-less-but-active themes still order sensibly.
  const themes = Array.from(byTheme.values()).sort((a, b) => {
    if (b.revenue_cents !== a.revenue_cents) return b.revenue_cents - a.revenue_cents;
    return b.outcomes - a.outcomes;
  });

  return {
    hasOutcomes: themes.length > 0,
    themes,
    totalOutcomes,
    totalRevenueCents,
  };
}

// Format integer cents as a $ string for the UI. Whole-dollar amounts drop the
// cents ("$1,200"); fractional amounts keep them ("$49.99"). Centralised so the
// page and any digest share one representation.
export function formatCents(cents: number): string {
  const dollars = cents / 100;
  const fractionDigits = cents % 100 === 0 ? 0 : 2;
  return `$${dollars.toLocaleString("en-US", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })}`;
}
