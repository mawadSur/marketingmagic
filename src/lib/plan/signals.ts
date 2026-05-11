import { supabaseService } from "@/lib/supabase/service";
import type { ThemeSignal } from "@/lib/plan/prompt";

const LOOKBACK_DAYS = 30;
const MIN_SAMPLE = 2;

export interface ThemeSignals {
  winners: ThemeSignal[];
  losers: ThemeSignal[];
  parent_plan_id: string | null;
}

// Pull per-theme engagement signals so plan N+1 leans into winners and reframes losers.
// Returns empty arrays for first-time plans — the generator handles that gracefully.
export async function collectThemeSignals(workspaceId: string): Promise<ThemeSignals> {
  const svc = supabaseService();
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const [plansRes, statsRes] = await Promise.all([
    svc
      .from("posting_plans")
      .select("id")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false })
      .limit(1),
    svc
      .from("posts")
      .select("theme, post_metrics(engagement_rate, fetched_at)")
      .eq("workspace_id", workspaceId)
      .eq("status", "posted")
      .gte("posted_at", since)
      .not("theme", "is", null),
  ]);

  const parent_plan_id = plansRes.data?.[0]?.id ?? null;
  type PostWithMetrics = {
    theme: string | null;
    post_metrics: Array<{ engagement_rate: number | null; fetched_at: string }>;
  };
  const rows = (statsRes.data ?? []) as unknown as PostWithMetrics[];

  const byTheme = new Map<string, { sum: number; count: number }>();
  for (const row of rows) {
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

  const themes: ThemeSignal[] = Array.from(byTheme.entries())
    .filter(([, v]) => v.count >= MIN_SAMPLE)
    .map(([theme, v]) => ({
      theme,
      engagement_rate: v.sum / v.count,
      sample_size: v.count,
    }))
    .sort((a, b) => (b.engagement_rate ?? 0) - (a.engagement_rate ?? 0));

  if (themes.length < 4) {
    return { winners: [], losers: [], parent_plan_id };
  }
  const topQuarter = Math.max(1, Math.floor(themes.length / 4));
  return {
    winners: themes.slice(0, topQuarter),
    losers: themes.slice(-topQuarter).reverse(),
    parent_plan_id,
  };
}
