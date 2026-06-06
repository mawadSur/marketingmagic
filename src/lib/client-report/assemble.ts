// ─────────────────────────────────────────────────────────────
// Agency Proof Engine — monthly client report assembly (bet ③)
// ─────────────────────────────────────────────────────────────
//
// Assembles the data behind the branded monthly "proof-of-work" report a cron
// emails to each client workspace under an org. It REUSES the existing analytics
// (getStatsByChannel, loadThemeWinners) so the figures never diverge from the
// in-app dashboard, and the portal-report data shape (PortalReport /
// PortalInsights) so the renderer is shared verbatim.
//
// Two things are specific to this monthly proof report:
//   1. WINDOW — the previous full calendar month (vs. the portal's all-time /
//      rolling reports). Computed from a passed-in `now` so it's testable.
//   2. OUTCOME / $ DATA — read from a `post_outcomes` table ANOTHER agent owns.
//      We DEFENSIVELY guard: if the table/data isn't there yet, we fall back to
//      engagement metrics with an explicit "outcome tracking not enabled" note.
//      We never create that table here.
//
// COLD START — a client with zero posts/outcomes in the month gets a graceful
// `quietMonth: true` report, not an empty/broken one. The renderer turns that
// into a friendly "quiet month" note.

import { supabaseService } from "@/lib/supabase/service";
import { getStatsByChannel, type ChannelStats } from "@/lib/dashboard/analytics";
import { loadThemeWinners, type ThemeWinner } from "@/lib/analytics/themes";

// ─── Calendar-month window ──────────────────────────────────────────────

export interface MonthWindow {
  start: Date; // inclusive, first instant of the month (UTC)
  end: Date; // exclusive, first instant of the next month (UTC)
  label: string; // e.g. "May 2026"
  // Whole-day span of the window — feeds the rolling-window analytics, which
  // take a day count rather than an explicit range. Always >= 28.
  days: number;
}

/**
 * The PREVIOUS full calendar month relative to `now` (UTC). Running the cron on
 * the 1st therefore reports the month that just ended — the natural "here's last
 * month" agency cadence.
 */
export function previousCalendarMonth(now: Date): MonthWindow {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const label = start.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  const days = Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
  return { start, end, label, days };
}

// ─── Report shapes ──────────────────────────────────────────────────────

// One post shipped in the window, with its latest metrics. Mirrors the portal
// report row shape so the renderer is shared.
export interface MonthlyPostRow {
  id: string;
  text: string;
  channel: string;
  posted_at: string | null;
  impressions: number | null;
  likes: number | null;
  reposts: number | null;
  replies: number | null;
  clicks: number | null;
  engagement_rate: number | null;
}

export interface MonthlyTotals {
  posts: number;
  impressions: number;
  engagements: number;
  avgEngagementRate: number | null;
}

// Outcome / $ rollup. `enabled` is false when the post_outcomes table or data
// isn't available yet (the dependency hasn't landed) — the renderer then shows
// the "outcome tracking not enabled" note instead of an outcomes section.
export interface OutcomeSummary {
  enabled: boolean;
  totalValueCents: number;
  count: number;
  // A few representative outcomes (most valuable first) for the report body.
  items: Array<{ outcomeType: string; valueCents: number; note: string | null }>;
}

export interface MonthlyClientReport {
  workspaceId: string;
  month: MonthWindow;
  posts: MonthlyPostRow[];
  totals: MonthlyTotals;
  channels: ChannelStats[];
  winningThemes: ThemeWinner[];
  outcomes: OutcomeSummary;
  // True when nothing shipped in the month — drives the graceful "quiet month"
  // copy in the renderer (never an empty/broken report).
  quietMonth: boolean;
}

const POSTS_LIMIT = 500;
const OUTCOME_ITEMS_LIMIT = 5;
const THEME_LIMIT = 5;

// ─── Outcome / $ data — defensive read of another agent's table ───────────
//
// The post_outcomes table is owned by a sibling agent and is NOT in the
// generated Database types, so we read it through an untyped accessor and guard
// every failure mode: missing table, RLS/permission error, or simply no rows.
// Any of those → { enabled:false } and the report falls back to engagement.

interface RawOutcomeRow {
  outcome_type?: unknown;
  value_cents?: unknown;
  note?: unknown;
}

function toInt(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

export async function loadOutcomes(
  workspaceId: string,
  window: MonthWindow,
): Promise<OutcomeSummary> {
  const empty: OutcomeSummary = {
    enabled: false,
    totalValueCents: 0,
    count: 0,
    items: [],
  };

  // Untyped accessor: post_outcomes isn't in the Database types (owned by
  // another agent). Cast narrowly so we can query it without weakening the
  // typed client elsewhere.
  const svc = supabaseService();
  const untyped = svc as unknown as {
    from: (table: string) => {
      select: (cols: string) => {
        eq: (
          col: string,
          val: string,
        ) => {
          gte: (
            col: string,
            val: string,
          ) => {
            lt: (
              col: string,
              val: string,
            ) => Promise<{ data: RawOutcomeRow[] | null; error: { message: string } | null }>;
          };
        };
      };
    };
  };

  let rows: RawOutcomeRow[] | null = null;
  try {
    const res = await untyped
      .from("post_outcomes")
      .select("outcome_type, value_cents, note")
      .eq("workspace_id", workspaceId)
      .gte("created_at", window.start.toISOString())
      .lt("created_at", window.end.toISOString());
    // A real error (missing table / no permission / dependency not landed yet)
    // → treat as "not enabled" and fall back to engagement.
    if (res.error) return empty;
    rows = res.data;
  } catch {
    // Network / unexpected shape → same graceful fallback.
    return empty;
  }

  const valid = (rows ?? []).filter((r) => r && typeof r.outcome_type === "string");
  if (valid.length === 0) {
    // Table exists but no outcomes this month: outcome tracking IS available,
    // just empty for the window. Surface enabled:true with a zero rollup so the
    // report can say "no outcomes logged this month" rather than hiding the
    // section entirely (distinct from the dependency-missing case above).
    return { enabled: true, totalValueCents: 0, count: 0, items: [] };
  }

  let totalValueCents = 0;
  const normalized = valid.map((r) => {
    const valueCents = toInt(r.value_cents);
    totalValueCents += valueCents;
    return {
      outcomeType: String(r.outcome_type),
      valueCents,
      note: typeof r.note === "string" ? r.note : null,
    };
  });
  normalized.sort((a, b) => b.valueCents - a.valueCents);

  return {
    enabled: true,
    totalValueCents,
    count: normalized.length,
    items: normalized.slice(0, OUTCOME_ITEMS_LIMIT),
  };
}

// ─── Posts + metrics for the month ───────────────────────────────────────

interface PostRow {
  id: string;
  text: string;
  channel: string;
  posted_at: string | null;
}

interface MetricRow {
  post_id: string;
  fetched_at: string;
  impressions: number | null;
  likes: number | null;
  reposts: number | null;
  replies: number | null;
  clicks: number | null;
  engagement_rate: number | null;
}

async function loadMonthlyPosts(
  workspaceId: string,
  window: MonthWindow,
): Promise<MonthlyPostRow[]> {
  const svc = supabaseService();

  // Posts published in the window, workspace-scoped.
  const { data: posts } = await svc
    .from("posts")
    .select("id, text, channel, posted_at")
    .eq("workspace_id", workspaceId)
    .eq("status", "posted")
    .gte("posted_at", window.start.toISOString())
    .lt("posted_at", window.end.toISOString())
    .order("posted_at", { ascending: false })
    .limit(POSTS_LIMIT);

  const postRows = (posts ?? []) as PostRow[];
  const postIds = postRows.map((p) => p.id);
  if (postIds.length === 0) return [];

  // Latest metric per post, constrained to the workspace-scoped id set (mirrors
  // the portal DAL — post_metrics has no workspace_id; the id set IS the scope).
  const { data: metrics } = await svc
    .from("post_metrics")
    .select("post_id, fetched_at, impressions, likes, reposts, replies, clicks, engagement_rate")
    .in("post_id", postIds)
    .order("fetched_at", { ascending: false });

  const latestByPost = new Map<string, MetricRow>();
  for (const m of (metrics ?? []) as MetricRow[]) {
    if (!latestByPost.has(m.post_id)) latestByPost.set(m.post_id, m);
  }

  return postRows.map((p) => {
    const m = latestByPost.get(p.id);
    return {
      id: p.id,
      text: p.text,
      channel: p.channel,
      posted_at: p.posted_at,
      impressions: m?.impressions ?? null,
      likes: m?.likes ?? null,
      reposts: m?.reposts ?? null,
      replies: m?.replies ?? null,
      clicks: m?.clicks ?? null,
      engagement_rate: m?.engagement_rate ?? null,
    };
  });
}

function totalsOf(rows: MonthlyPostRow[]): MonthlyTotals {
  let impressions = 0;
  let engagements = 0;
  const erValues: number[] = [];
  for (const r of rows) {
    impressions += r.impressions ?? 0;
    engagements += (r.likes ?? 0) + (r.reposts ?? 0) + (r.replies ?? 0) + (r.clicks ?? 0);
    if (typeof r.engagement_rate === "number") erValues.push(r.engagement_rate);
  }
  const avgEngagementRate =
    erValues.length > 0 ? erValues.reduce((a, b) => a + b, 0) / erValues.length : null;
  return { posts: rows.length, impressions, engagements, avgEngagementRate };
}

/**
 * Assemble the full monthly proof-of-work report for one client workspace.
 *
 * SECURITY: every query is scoped to `workspaceId` (the caller — the cron —
 * derives the id set from the org → client-workspaces join under RLS-free
 * service role, exactly like the sibling crons). The reused analytics each
 * filter on this single id.
 */
export async function assembleMonthlyReport(
  workspaceId: string,
  now: Date,
): Promise<MonthlyClientReport> {
  const month = previousCalendarMonth(now);

  // Reuse the dashboard + theme analytics so the proof report and the in-app
  // dashboard show identical figures. Both take a rolling day-count window; we
  // pass the month's day span so the per-channel + theme breakdowns line up with
  // the post list as closely as a rolling window allows.
  const [posts, channels, winningThemes, outcomes] = await Promise.all([
    loadMonthlyPosts(workspaceId, month),
    getStatsByChannel(workspaceId, month.days),
    loadThemeWinners(workspaceId, THEME_LIMIT),
    loadOutcomes(workspaceId, month),
  ]);

  const totals = totalsOf(posts);
  const quietMonth = posts.length === 0 && outcomes.count === 0;

  return {
    workspaceId,
    month,
    posts,
    totals,
    channels,
    winningThemes,
    outcomes,
    quietMonth,
  };
}
