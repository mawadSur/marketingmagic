import { supabaseService } from "@/lib/supabase/service";

export interface KpiSummary {
  posts_shipped_7d: number;
  approval_rate: number | null;
  total_impressions_7d: number;
  pending_count: number;
  top_theme: { theme: string; engagement_rate: number } | null;
}

export interface ThemeRow {
  theme: string;
  posts: number;
  avg_engagement_rate: number;
}

export interface CalendarPost {
  id: string;
  text: string;
  theme: string | null;
  channel: string;
  status: string;
  scheduled_at: string | null;
  posted_at: string | null;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function getKpiSummary(workspaceId: string): Promise<KpiSummary> {
  const svc = supabaseService();
  const since = new Date(Date.now() - WEEK_MS).toISOString();

  const [shippedRes, pendingRes, approvalsRes, themesRes] = await Promise.all([
    svc
      .from("posts")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("status", "posted")
      .gte("posted_at", since),
    svc
      .from("posts")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("status", "pending_approval"),
    svc
      .from("approvals")
      .select("action, post_id, posts!inner(workspace_id)")
      .eq("posts.workspace_id", workspaceId)
      .gte("created_at", since),
    getThemeLeaderboard(workspaceId),
  ]);

  const approvalRows = (approvalsRes.data ?? []) as Array<{ action: string }>;
  const approveCount = approvalRows.filter((a) => a.action === "approved").length;
  const editCount = approvalRows.filter((a) => a.action === "edited").length;
  const denominator = approveCount + editCount;
  const approval_rate = denominator === 0 ? null : approveCount / denominator;

  const impressions = await getImpressionsLastWeek(workspaceId, since);
  const top = themesRes[0] ?? null;

  return {
    posts_shipped_7d: shippedRes.count ?? 0,
    approval_rate,
    total_impressions_7d: impressions,
    pending_count: pendingRes.count ?? 0,
    top_theme: top ? { theme: top.theme, engagement_rate: top.avg_engagement_rate } : null,
  };
}

async function getImpressionsLastWeek(workspaceId: string, since: string): Promise<number> {
  const svc = supabaseService();
  const { data } = await svc
    .from("posts")
    .select("post_metrics(impressions, fetched_at)")
    .eq("workspace_id", workspaceId)
    .eq("status", "posted")
    .gte("posted_at", since);

  type Row = { post_metrics: Array<{ impressions: number | null; fetched_at: string }> };
  let total = 0;
  for (const row of (data ?? []) as unknown as Row[]) {
    const latest = row.post_metrics
      .slice()
      .sort((a, b) => +new Date(b.fetched_at) - +new Date(a.fetched_at))[0];
    total += latest?.impressions ?? 0;
  }
  return total;
}

export async function getThemeLeaderboard(workspaceId: string): Promise<ThemeRow[]> {
  const svc = supabaseService();
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await svc
    .from("posts")
    .select("theme, post_metrics(engagement_rate, fetched_at)")
    .eq("workspace_id", workspaceId)
    .eq("status", "posted")
    .gte("posted_at", since)
    .not("theme", "is", null);

  type Row = {
    theme: string | null;
    post_metrics: Array<{ engagement_rate: number | null; fetched_at: string }>;
  };
  const byTheme = new Map<string, { sum: number; count: number }>();
  for (const row of (data ?? []) as unknown as Row[]) {
    if (!row.theme) continue;
    const latest = row.post_metrics
      .slice()
      .sort((a, b) => +new Date(b.fetched_at) - +new Date(a.fetched_at))[0];
    if (!latest || latest.engagement_rate == null) continue;
    const agg = byTheme.get(row.theme) ?? { sum: 0, count: 0 };
    agg.sum += latest.engagement_rate;
    agg.count += 1;
    byTheme.set(row.theme, agg);
  }

  return Array.from(byTheme.entries())
    .map(([theme, v]) => ({
      theme,
      posts: v.count,
      avg_engagement_rate: v.sum / v.count,
    }))
    .sort((a, b) => b.avg_engagement_rate - a.avg_engagement_rate)
    .slice(0, 10);
}

export async function getCalendar(workspaceId: string, daysAhead = 14): Promise<CalendarPost[]> {
  const svc = supabaseService();
  const until = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data } = await svc
    .from("posts")
    .select("id, text, theme, channel, status, scheduled_at, posted_at")
    .eq("workspace_id", workspaceId)
    .in("status", ["scheduled", "posted", "pending_approval"])
    .or(`scheduled_at.gte.${since},posted_at.gte.${since}`)
    .lte("scheduled_at", until)
    .order("scheduled_at", { ascending: true })
    .limit(60);

  return data ?? [];
}
