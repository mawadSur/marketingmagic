import { supabaseService } from "@/lib/supabase/service";
import type { PostExemplar, ThemeSignal } from "@/lib/plan/prompt";
import { loadWorkspacePerformance } from "@/lib/feedback/post-performance";

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

// Phase 8 (dedup wedge) — collect the workspace's best and worst *individual*
// posts for the planner's exemplar block (postExemplarsBlock in
// src/lib/plan/prompt.ts).
//
// Where collectThemeSignals (above) rolls performance up by THEME, this surfaces
// specific posts: the few that ran well above this workspace's decay-weighted
// baseline (so Claude can study the *shape* that lands for this brand) and the
// few that flopped (so it can steer clear of that shape). The per-post scoring —
// the decay-weighted baseline, the ratio, and the winner/underperformer
// verdicts — all live in loadWorkspacePerformance(); we just rank its output and
// attach the post text + theme it doesn't carry.
//
// loadWorkspacePerformance returns a Map keyed by postId but, by design, carries
// only the numeric verdict (no text/theme — it's the scoring layer, not a
// content read). So once we know WHICH posts won and lost, we do a single small
// extra read keyed by exactly those ids to pull their text + theme. That keeps
// the heavy corpus read inside the performance loader and the content read here
// tiny (at most ~6 rows).

const EXEMPLARS_PER_SIDE = 3;
const EXEMPLAR_TEXT_MAX = 200;

export async function collectPostExemplars(workspaceId: string): Promise<PostExemplar[]> {
  // The scoring layer judges every posted post against the full-workspace,
  // decay-weighted corpus and hands back per-post verdicts + ratios.
  const perf = await loadWorkspacePerformance(workspaceId);

  // Rank the clear winners (highest ratio first) and the clear underperformers
  // (lowest ratio first). Both verdicts always have a non-null ratio — the
  // scorer only assigns them when a baseline exists — but we coerce defensively.
  const entries = Array.from(perf.values());
  const trueWinners = entries
    .filter((p) => p.verdict === "winner")
    .sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0));
  // STRONG FALLBACK: when there aren't enough true 'winner' posts to fill the
  // winners side, top it up with the next-best 'strong' posts (highest ratio
  // first) so the winners pool isn't asymmetrically empty. We do NOT do the
  // reverse for losers — fabricating weak "underperformers" would teach the
  // planner to avoid shapes that actually landed fine.
  const strong = entries
    .filter((p) => p.verdict === "strong")
    .sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0));
  const underperformers = entries
    .filter((p) => p.verdict === "underperformer")
    .sort((a, b) => (a.ratio ?? 0) - (b.ratio ?? 0));

  // We may surface at most EXEMPLARS_PER_SIDE per side AFTER dropping any post
  // whose text won't load. To avoid a null-text post silently shrinking the
  // count, keep a deeper bench of candidates per side here, fetch text for the
  // whole bench, then take the first EXEMPLARS_PER_SIDE that actually have text.
  const winnerBench = [...trueWinners, ...strong].slice(0, EXEMPLARS_PER_SIDE * 2);
  const loserBench = underperformers.slice(0, EXEMPLARS_PER_SIDE * 2);

  const candidates = [...winnerBench, ...loserBench];
  if (candidates.length === 0) return [];

  // Single small extra read for the text + theme the scorer doesn't carry,
  // keyed by exactly the ids on the bench (≤12 rows).
  const svc = supabaseService();
  const ids = candidates.map((p) => p.postId);
  const { data, error } = await svc
    .from("posts")
    .select("id, text, theme")
    .eq("workspace_id", workspaceId)
    .in("id", ids);

  if (error || !data) return [];

  type PostText = { id: string; text: string | null; theme: string | null };
  const byId = new Map<string, PostText>();
  for (const r of data as unknown as PostText[]) byId.set(r.id, r);

  // Map each ranked post to its exemplar. Drop any post whose text we couldn't
  // load — an exemplar with no text teaches the planner nothing — and only THEN
  // cap to EXEMPLARS_PER_SIDE per side, so a null-text post back-fills with the
  // next-best rather than reducing the surfaced count. A fell-back 'strong' post
  // is emitted under the prompt's 'winner' label (it's on the winners side).
  const toExemplar = (p: (typeof candidates)[number]): PostExemplar | null => {
    const content = byId.get(p.postId);
    if (!content || !content.text) return null;
    return {
      verdict: p.verdict === "underperformer" ? "underperformer" : "winner",
      theme: content.theme,
      ratio: p.ratio ?? 0,
      text: content.text.slice(0, EXEMPLAR_TEXT_MAX),
    };
  };

  const winnerExemplars = winnerBench
    .map(toExemplar)
    .filter((e): e is PostExemplar => e !== null)
    .slice(0, EXEMPLARS_PER_SIDE);
  const loserExemplars = loserBench
    .map(toExemplar)
    .filter((e): e is PostExemplar => e !== null)
    .slice(0, EXEMPLARS_PER_SIDE);

  return [...winnerExemplars, ...loserExemplars];
}
