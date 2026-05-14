import { supabaseService } from "@/lib/supabase/service";

// Workspace-level context for the explainer prompt. Computed once per
// dashboard render and reused across cards so we don't N+1 query the same
// rolling 28-day aggregates.

interface PostMetricsRow {
  engagement_rate: number | null;
  fetched_at: string;
}

interface ThemePostRow {
  theme: string | null;
  post_metrics: PostMetricsRow[];
}

interface LengthPostRow {
  text: string | null;
  post_metrics: PostMetricsRow[];
}

const LOOKBACK_DAYS = 28;

function latestRate(rows: PostMetricsRow[]): number | null {
  if (!rows || rows.length === 0) return null;
  const latest = rows
    .slice()
    .sort((a, b) => +new Date(b.fetched_at) - +new Date(a.fetched_at))[0];
  return latest?.engagement_rate ?? null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export interface WorkspaceExplainerContext {
  // Per-theme median engagement rate over last 28d.
  themeMedians: Map<string, number>;
  // Workspace overall median engagement rate (same baseline outliers.ts uses,
  // recomputed here so this module is self-contained).
  workspaceMedian: number | null;
  // Median char length of the workspace's *top-quartile* posts by engagement.
  // Null when there's not enough data.
  winnerMedianChars: number | null;
}

export async function loadWorkspaceContext(workspaceId: string): Promise<WorkspaceExplainerContext> {
  const svc = supabaseService();
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data } = await svc
    .from("posts")
    .select("text, theme, post_metrics(engagement_rate, fetched_at)")
    .eq("workspace_id", workspaceId)
    .eq("status", "posted")
    .gte("posted_at", since);

  const rows = (data ?? []) as unknown as Array<ThemePostRow & LengthPostRow>;

  // Workspace baseline.
  const allRates: number[] = [];
  for (const r of rows) {
    const v = latestRate(r.post_metrics);
    if (v != null) allRates.push(v);
  }
  const workspaceMedian = median(allRates);

  // Per-theme medians.
  const byTheme = new Map<string, number[]>();
  for (const r of rows) {
    if (!r.theme) continue;
    const v = latestRate(r.post_metrics);
    if (v == null) continue;
    const bucket = byTheme.get(r.theme) ?? [];
    bucket.push(v);
    byTheme.set(r.theme, bucket);
  }
  const themeMedians = new Map<string, number>();
  for (const [theme, values] of byTheme.entries()) {
    const m = median(values);
    if (m != null) themeMedians.set(theme, m);
  }

  // Winner median chars: top quartile of engagement → median length.
  let winnerMedianChars: number | null = null;
  if (workspaceMedian != null && rows.length >= 4) {
    const ranked = rows
      .map((r) => ({ text: r.text ?? "", rate: latestRate(r.post_metrics) }))
      .filter((r): r is { text: string; rate: number } => r.rate != null)
      .sort((a, b) => b.rate - a.rate);
    const cutoff = Math.max(1, Math.floor(ranked.length / 4));
    const lengths = ranked.slice(0, cutoff).map((r) => r.text.length);
    winnerMedianChars = median(lengths);
  }

  return { themeMedians, workspaceMedian, winnerMedianChars };
}

// Compute theme lift = theme-median / workspace-median. Returns null when
// either side is missing (small workspaces or untagged posts).
export function themeLift(
  ctx: WorkspaceExplainerContext,
  theme: string | null,
): number | null {
  if (!theme) return null;
  if (ctx.workspaceMedian == null || ctx.workspaceMedian <= 0) return null;
  const themeMed = ctx.themeMedians.get(theme);
  if (themeMed == null) return null;
  return themeMed / ctx.workspaceMedian;
}
