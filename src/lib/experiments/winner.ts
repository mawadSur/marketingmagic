// Phase 6B — Quick Experiments winner evaluation.
//
// evaluateExperiment(experimentId) inspects an experiment + its variants
// and either declares a directional winner OR returns "not yet" with a
// reason. Every variant must have ≥48h of metrics before we'll touch
// the verdict — short of that, we don't have settled engagement numbers.
//
// IMPORTANT: this is NOT a statistically rigorous test. Variants post
// sequentially, not randomly, so the verdict is contaminated by
// time-of-day / day-of-week effects and any platform changes between
// posts. Every surface that consumes this output MUST label the verdict
// as "directional, not statistically rigorous" — the banner copy is
// exported from this module so the UI can use it verbatim.

import { supabaseService } from "@/lib/supabase/service";

// Hard gate — every variant needs this much metric maturity before we'll
// declare a winner. Mirrors the 48h baseline used in the spec.
export const MIN_METRICS_HOURS = 48;

// Banner copy surfaced anywhere a winner is shown. Centralised here so
// the dashboard widget, the queue row, and any future surfaces stay
// consistent. The text deliberately echoes the Phase 6.7 "possible
// reasons, never certainties" register.
export const DIRECTIONAL_BANNER =
  "Directional, not statistically rigorous. Variants posted sequentially — verdict is contaminated by time-of-day, day-of-week, and platform-state effects between posts.";

// Verdict types — three shapes:
//   - declared: we have a winner (always directional)
//   - no_signal: ≥48h metrics in but the lift is too small to call
//   - waiting:   not enough metric age yet on at least one variant
//   - error:     experiment row missing / corrupted
export type WinnerVerdict =
  | { kind: "declared"; winner: WinnerVariantSummary; baseline: number; directional: true; banner: string; variants: VariantSummary[] }
  | { kind: "no_signal"; baseline: number; directional: true; banner: string; variants: VariantSummary[] }
  | { kind: "waiting"; reason: string; variants: VariantSummary[] }
  | { kind: "error"; reason: string };

export interface VariantSummary {
  variant_id: string;
  post_id: string;
  text: string;
  hook: string | null;
  posted_at: string | null;
  hours_since_post: number | null;
  impressions: number;
  engagement: number;
  engagement_rate: number;
  lift_vs_parent: number;
}

export interface WinnerVariantSummary extends VariantSummary {
  variant_id: string;
}

interface MetricsRow {
  engagement_rate: number | null;
  impressions: number | null;
  likes: number | null;
  reposts: number | null;
  replies: number | null;
  fetched_at: string;
}

interface PostRow {
  id: string;
  text: string;
  posted_at: string | null;
  generation_metadata: unknown;
  post_metrics: MetricsRow[];
}

interface VariantRow {
  id: string;
  parent_post_id: string;
  posts: PostRow | null;
}

interface ExperimentRow {
  id: string;
  workspace_id: string;
  parent_post_id: string;
  status: string;
  parent_post: PostRow | null;
  post_variants: VariantRow[];
}

const HOUR_MS = 60 * 60 * 1000;

export async function evaluateExperiment(experimentId: string): Promise<WinnerVerdict> {
  const svc = supabaseService();

  // Two-step load. PostgREST struggles to disambiguate the parent_post
  // FK from the post_variants->posts edge when both target `posts`, so we
  // pull the parent in a separate query rather than relying on a fragile
  // !constraint-name hint. The extra round-trip is fine — this evaluator
  // runs from a manual button click and the dashboard widget caches the
  // result on `experiments.winner_variant_id` after the first call.
  const expRes = await svc
    .from("experiments")
    .select(
      "id, workspace_id, parent_post_id, status, " +
        "post_variants(id, parent_post_id, posts(id, text, posted_at, generation_metadata, post_metrics(engagement_rate, impressions, likes, reposts, replies, fetched_at)))",
    )
    .eq("id", experimentId)
    .maybeSingle();

  if (expRes.error || !expRes.data) {
    return { kind: "error", reason: expRes.error?.message ?? "Experiment not found." };
  }
  const expData = expRes.data as unknown as {
    id: string;
    workspace_id: string;
    parent_post_id: string;
    status: string;
    post_variants: VariantRow[];
  };

  const parentRes = await svc
    .from("posts")
    .select(
      "id, text, posted_at, generation_metadata, post_metrics(engagement_rate, impressions, likes, reposts, replies, fetched_at)",
    )
    .eq("id", expData.parent_post_id)
    .maybeSingle();

  if (!parentRes.data) {
    return { kind: "error", reason: "Parent post missing (was it deleted?)." };
  }
  const parentData = parentRes.data as unknown as PostRow;
  const exp: ExperimentRow = { ...expData, parent_post: parentData };

  const now = Date.now();
  if (!exp.parent_post) {
    return { kind: "error", reason: "Parent post missing (was it deleted?)." };
  }
  const parentSummary = summarisePost(exp.parent_post, now, 0);
  const parentRate = parentSummary.engagement_rate;

  const variantSummaries: VariantSummary[] = [];
  for (const v of exp.post_variants ?? []) {
    if (!v.posts) continue;
    const s = summarisePost(v.posts, now, parentRate);
    variantSummaries.push({ ...s, variant_id: v.id });
  }

  if (variantSummaries.length === 0) {
    return { kind: "error", reason: "No variants attached to this experiment." };
  }

  // Gate: every variant needs ≥48h of post age. We measure from posted_at
  // (the dispatcher fills this), not scheduled_at — a scheduled-but-not-
  // -yet-posted variant blocks the verdict.
  const notReady = variantSummaries.filter(
    (v) => v.hours_since_post == null || v.hours_since_post < MIN_METRICS_HOURS,
  );
  if (notReady.length > 0) {
    const minWait = Math.min(
      ...notReady.map((v) =>
        v.hours_since_post == null
          ? MIN_METRICS_HOURS
          : Math.max(0, MIN_METRICS_HOURS - v.hours_since_post),
      ),
    );
    return {
      kind: "waiting",
      reason: `Waiting on ${notReady.length} variant${notReady.length === 1 ? "" : "s"} — minimum ${Math.ceil(minWait)}h more of metrics needed.`,
      variants: variantSummaries,
    };
  }

  // Pick the variant with the highest engagement rate. We require a
  // *positive* lift over the parent to declare any winner — if every
  // variant underperforms the parent, the verdict is "no_signal" (the
  // experiment was directionally a wash).
  const sorted = [...variantSummaries].sort(
    (a, b) => b.engagement_rate - a.engagement_rate,
  );
  const best = sorted[0];

  // No-signal threshold: require ≥10% lift over the parent to declare.
  // Anything less is plausibly noise even before contamination effects.
  const NO_SIGNAL_LIFT = 1.1;
  if (best.lift_vs_parent < NO_SIGNAL_LIFT) {
    return {
      kind: "no_signal",
      baseline: parentRate,
      directional: true,
      banner: DIRECTIONAL_BANNER,
      variants: variantSummaries,
    };
  }

  return {
    kind: "declared",
    winner: best as WinnerVariantSummary,
    baseline: parentRate,
    directional: true,
    banner: DIRECTIONAL_BANNER,
    variants: variantSummaries,
  };
}

function summarisePost(p: PostRow, nowMs: number, parentRate: number): VariantSummary {
  const latest = p.post_metrics
    .slice()
    .sort((a, b) => +new Date(b.fetched_at) - +new Date(a.fetched_at))[0];
  const impressions = latest?.impressions ?? 0;
  const engagements =
    (latest?.likes ?? 0) + (latest?.reposts ?? 0) + (latest?.replies ?? 0);
  const rate =
    typeof latest?.engagement_rate === "number" && latest.engagement_rate != null
      ? latest.engagement_rate
      : impressions > 0
        ? engagements / impressions
        : 0;
  const hoursSincePost =
    p.posted_at != null
      ? Math.max(0, (nowMs - +new Date(p.posted_at)) / HOUR_MS)
      : null;
  const meta = (p.generation_metadata ?? {}) as { hook?: string | null };
  return {
    variant_id: "", // filled by caller for variant rows; parent leaves it ""
    post_id: p.id,
    text: p.text,
    hook: typeof meta.hook === "string" ? meta.hook : null,
    posted_at: p.posted_at,
    hours_since_post: hoursSincePost,
    impressions,
    engagement: engagements,
    engagement_rate: rate,
    lift_vs_parent: parentRate > 0 ? rate / parentRate : rate > 0 ? Infinity : 1,
  };
}

// Helper: persists the verdict back to the experiments row when the
// kind is "declared". Idempotent — safe to call repeatedly.
export async function persistDeclaredWinner(
  experimentId: string,
  verdict: WinnerVerdict,
): Promise<void> {
  if (verdict.kind !== "declared") return;
  const svc = supabaseService();
  // Cache metrics_snapshot on the winning variant for the dashboard.
  const snapshot = {
    engagement_rate: verdict.winner.engagement_rate,
    impressions: verdict.winner.impressions,
    engagement: verdict.winner.engagement,
    sample_age_hours: verdict.winner.hours_since_post ?? null,
  };
  await svc
    .from("post_variants")
    .update({ metrics_snapshot: snapshot as never })
    .eq("id", verdict.winner.variant_id);
  await svc
    .from("experiments")
    .update({
      status: "complete",
      winner_variant_id: verdict.winner.variant_id,
      completed_at: new Date().toISOString(),
    })
    .eq("id", experimentId);
}
