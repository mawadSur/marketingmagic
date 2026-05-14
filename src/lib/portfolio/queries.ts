import { supabaseService } from "@/lib/supabase/service";

/**
 * Per-workspace KPI rollup for the multi-client `/portfolio` page.
 *
 * Mirrors the same metrics surfaced on `/dashboard` (posts shipped 7d,
 * approval rate, top theme, engagement trend) but only the cheap reads —
 * we run this in parallel across every workspace the user belongs to.
 *
 * Workspace IDs flowing in MUST be pre-scoped to the caller via
 * `listWorkspaces()` (RLS-gated). We then bypass RLS via
 * `supabaseService()` for the same reason `src/lib/dashboard/queries.ts`
 * does: cross-table joins through `posts → post_metrics` are awkward
 * under member-scoped clients.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export interface WorkspaceKpis {
  workspace_id: string;
  posts_shipped_7d: number;
  approval_rate: number | null; // null when there's no signal
  pending_count: number;
  stale_pending_count: number; // pending_approval AND created_at < 24h ago
  total_impressions_7d: number;
  engagement_rate_7d: number | null;
  engagement_trend_pct: number | null; // 7d vs prior-7d, decimal (0.12 = +12%)
  top_theme: { theme: string; engagement_rate: number } | null;
}

interface PostRow {
  id: string;
  status: string;
  posted_at: string | null;
  created_at: string;
}

interface MetricsJoinRow {
  theme: string | null;
  posted_at: string | null;
  post_metrics: Array<{
    impressions: number | null;
    engagement_rate: number | null;
    likes: number | null;
    reposts: number | null;
    replies: number | null;
    clicks: number | null;
    fetched_at: string;
  }>;
}

interface ApprovalRow {
  action: string;
}

/**
 * Aggregate KPIs for a single workspace. Designed to be `Promise.all`-able
 * across every workspace the user has membership in.
 */
export async function getWorkspaceKpis(workspaceId: string): Promise<WorkspaceKpis> {
  const svc = supabaseService();
  const now = Date.now();
  const since7 = new Date(now - WEEK_MS).toISOString();
  const since14 = new Date(now - 2 * WEEK_MS).toISOString();
  const stale24h = new Date(now - DAY_MS).toISOString();

  const [postsRes, approvalsRes, metricsRes] = await Promise.all([
    svc
      .from("posts")
      .select("id, status, posted_at, created_at")
      .eq("workspace_id", workspaceId)
      .or(`posted_at.gte.${since14},status.eq.pending_approval`),
    svc
      .from("approvals")
      .select("action, post_id, posts!inner(workspace_id)")
      .eq("posts.workspace_id", workspaceId)
      .gte("created_at", since7),
    svc
      .from("posts")
      .select("theme, posted_at, post_metrics(impressions, engagement_rate, likes, reposts, replies, clicks, fetched_at)")
      .eq("workspace_id", workspaceId)
      .eq("status", "posted")
      .gte("posted_at", since14),
  ]);

  const posts = (postsRes.data ?? []) as PostRow[];
  const approvals = (approvalsRes.data ?? []) as unknown as ApprovalRow[];
  const metricsRows = (metricsRes.data ?? []) as unknown as MetricsJoinRow[];

  // Posts shipped (7d) and pending counts.
  let posts_shipped_7d = 0;
  let pending_count = 0;
  let stale_pending_count = 0;
  for (const p of posts) {
    if (p.status === "posted" && p.posted_at && p.posted_at >= since7) {
      posts_shipped_7d += 1;
    }
    if (p.status === "pending_approval") {
      pending_count += 1;
      if (p.created_at < stale24h) stale_pending_count += 1;
    }
  }

  // Approval rate (last 7d). Approvals / (approvals + edits). Rejects don't
  // change the denominator — they're a separate signal.
  let approveCount = 0;
  let editCount = 0;
  for (const a of approvals) {
    if (a.action === "approved") approveCount += 1;
    else if (a.action === "edited") editCount += 1;
  }
  const denom = approveCount + editCount;
  const approval_rate = denom === 0 ? null : approveCount / denom;

  // Engagement aggregation. We need:
  //   - total impressions in last 7d
  //   - avg engagement rate in last 7d
  //   - engagement rate trend (7d vs prior 7d)
  //   - top theme by avg engagement rate in last 14d
  let imp7 = 0;
  let engSum7 = 0;
  let engCount7 = 0;
  let engSumPrev = 0;
  let engCountPrev = 0;
  const byTheme = new Map<string, { sum: number; count: number }>();

  for (const row of metricsRows) {
    if (!row.posted_at) continue;
    const latest = row.post_metrics
      .slice()
      .sort((a, b) => +new Date(b.fetched_at) - +new Date(a.fetched_at))[0];
    if (!latest) continue;
    const inLast7 = row.posted_at >= since7;
    const inPrior7 = !inLast7 && row.posted_at >= since14;

    if (inLast7) {
      imp7 += latest.impressions ?? 0;
      if (latest.engagement_rate != null) {
        engSum7 += latest.engagement_rate;
        engCount7 += 1;
      }
    } else if (inPrior7 && latest.engagement_rate != null) {
      engSumPrev += latest.engagement_rate;
      engCountPrev += 1;
    }

    if (row.theme && latest.engagement_rate != null) {
      const agg = byTheme.get(row.theme) ?? { sum: 0, count: 0 };
      agg.sum += latest.engagement_rate;
      agg.count += 1;
      byTheme.set(row.theme, agg);
    }
  }

  const engagement_rate_7d = engCount7 === 0 ? null : engSum7 / engCount7;
  const prior = engCountPrev === 0 ? null : engSumPrev / engCountPrev;
  // Trend: (current - prior) / prior. Only show when both windows have data.
  const engagement_trend_pct =
    engagement_rate_7d != null && prior != null && prior > 0
      ? (engagement_rate_7d - prior) / prior
      : null;

  let top_theme: WorkspaceKpis["top_theme"] = null;
  for (const [theme, v] of byTheme.entries()) {
    const rate = v.sum / v.count;
    if (!top_theme || rate > top_theme.engagement_rate) {
      top_theme = { theme, engagement_rate: rate };
    }
  }

  return {
    workspace_id: workspaceId,
    posts_shipped_7d,
    approval_rate,
    pending_count,
    stale_pending_count,
    total_impressions_7d: imp7,
    engagement_rate_7d,
    engagement_trend_pct,
    top_theme,
  };
}
