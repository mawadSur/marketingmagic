import Link from "next/link";
import { supabaseService } from "@/lib/supabase/service";
import { Badge } from "@/components/ui/badge";
import { DIRECTIONAL_BANNER } from "@/lib/experiments/winner";

// Phase 6B — Quick Experiments dashboard widget.
//
// Server component. Mounted in /dashboard. Renders:
//   - Active experiments (variants scheduled, no verdict yet)
//   - Completed-with-winner experiments (winner_variant_id is set)
//
// Cap at 5 visible rows total to keep the dashboard quiet. Hide the
// widget entirely when there are zero rows — empty surfaces are worse
// than no surfaces for "feature you haven't tried yet" UX.

const MAX_VISIBLE = 5;

interface ExperimentSummary {
  id: string;
  status: "active" | "complete";
  variant_count: number;
  created_at: string;
  completed_at: string | null;
  parent_post: {
    id: string;
    text: string;
    channel: string;
  } | null;
  winner_post: {
    id: string;
    text: string;
  } | null;
  winner_metrics: {
    engagement_rate: number | null;
    impressions: number | null;
    engagement: number | null;
  } | null;
}

export async function QuickExperimentsWidget({ workspaceId }: { workspaceId: string }) {
  const summaries = await loadSummaries(workspaceId);
  if (summaries.length === 0) return null;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="label-eyebrow">Quick Experiments</p>
          <h2 className="text-base font-medium">Variant tests in flight</h2>
        </div>
        <p className="max-w-md text-xs text-muted-foreground">{DIRECTIONAL_BANNER}</p>
      </div>
      <ul className="divide-y rounded-lg border bg-card">
        {summaries.map((s) => (
          <ExperimentRow key={s.id} summary={s} />
        ))}
      </ul>
    </section>
  );
}

function ExperimentRow({ summary }: { summary: ExperimentSummary }) {
  const parentText = summary.parent_post?.text ?? "(parent post removed)";
  const winnerRate = summary.winner_metrics?.engagement_rate;
  return (
    <li className="space-y-1.5 px-4 py-3.5 text-sm transition-colors duration-200 hover:bg-muted/30">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={summary.status === "complete" ? "success" : "info"}>
          {summary.status === "complete" ? "Winner declared" : "Active"}
        </Badge>
        <span className="text-xs text-muted-foreground tabular-nums">
          {summary.variant_count} variants
        </span>
        {summary.status === "active" ? (
          <span className="text-xs text-muted-foreground">
            started {summary.created_at.slice(0, 10)}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">
            completed {(summary.completed_at ?? "").slice(0, 10)}
          </span>
        )}
      </div>
      <p className="line-clamp-1 text-muted-foreground">
        <span className="text-foreground">Parent:</span> {parentText}
      </p>
      {summary.status === "complete" && summary.winner_post ? (
        <div className="space-y-0.5">
          <p className="line-clamp-1">
            <span className="text-xs uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
              Winner:
            </span>{" "}
            {summary.winner_post.text}
          </p>
          {winnerRate != null ? (
            <p className="text-xs text-muted-foreground tabular-nums">
              {(winnerRate * 100).toFixed(2)}% engagement · directional verdict
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Variants need ≥48h of metrics before we&apos;ll call a directional winner.{" "}
          <Link href="/queue" className="underline">
            Open queue
          </Link>
        </p>
      )}
    </li>
  );
}

async function loadSummaries(workspaceId: string): Promise<ExperimentSummary[]> {
  const svc = supabaseService();
  const { data: experiments } = await svc
    .from("experiments")
    .select("id, status, variant_count, created_at, completed_at, parent_post_id, winner_variant_id")
    .eq("workspace_id", workspaceId)
    .in("status", ["active", "complete"])
    .order("created_at", { ascending: false })
    .limit(MAX_VISIBLE);

  if (!experiments || experiments.length === 0) return [];

  const parentIds = experiments
    .map((e) => e.parent_post_id)
    .filter((id): id is string => !!id);
  const winnerVariantIds = experiments
    .map((e) => e.winner_variant_id)
    .filter((id): id is string => !!id);

  // Parent posts (headline text) + winner variants (metrics_snapshot)
  // in parallel. We deliberately do NOT join through `post_variants ->
  // posts` because PostgREST has trouble disambiguating that FK from the
  // `experiments.parent_post_id` FK (both target `posts`). Three queries,
  // negligible cost — the widget caps at 5 rows.
  const [parentsRes, variantsRes] = await Promise.all([
    parentIds.length > 0
      ? svc.from("posts").select("id, text, channel").in("id", parentIds)
      : Promise.resolve({ data: [] as Array<{ id: string; text: string; channel: string }> }),
    winnerVariantIds.length > 0
      ? svc
          .from("post_variants")
          .select("id, parent_post_id, metrics_snapshot")
          .in("id", winnerVariantIds)
      : Promise.resolve({
          data: [] as Array<{
            id: string;
            parent_post_id: string;
            metrics_snapshot: unknown;
          }>,
        }),
  ]);

  // Resolve each winner variant's underlying post text via a separate
  // lookup. Cap on 5 rows means at most 5 IDs here.
  const winnerPostIds = (variantsRes.data ?? [])
    .map((v) => v.parent_post_id)
    .filter((id): id is string => !!id);
  const winnerPostsRes =
    winnerPostIds.length > 0
      ? await svc.from("posts").select("id, text").in("id", winnerPostIds)
      : { data: [] as Array<{ id: string; text: string }> };

  const parentById = new Map<string, { id: string; text: string; channel: string }>();
  for (const p of parentsRes.data ?? []) parentById.set(p.id, p);
  const winnerPostById = new Map<string, { id: string; text: string }>();
  for (const p of winnerPostsRes.data ?? []) winnerPostById.set(p.id, p);

  const winnerById = new Map<
    string,
    {
      post: { id: string; text: string } | null;
      metrics: { engagement_rate: number | null; impressions: number | null; engagement: number | null } | null;
    }
  >();
  for (const w of (variantsRes.data ?? []) as Array<{
    id: string;
    parent_post_id: string;
    metrics_snapshot: unknown;
  }>) {
    const snap = (w.metrics_snapshot ?? null) as
      | {
          engagement_rate?: number | null;
          impressions?: number | null;
          engagement?: number | null;
        }
      | null;
    winnerById.set(w.id, {
      post: w.parent_post_id ? winnerPostById.get(w.parent_post_id) ?? null : null,
      metrics: snap
        ? {
            engagement_rate: snap.engagement_rate ?? null,
            impressions: snap.impressions ?? null,
            engagement: snap.engagement ?? null,
          }
        : null,
    });
  }

  return experiments
    .filter((e) => e.status === "active" || e.status === "complete")
    .map((e) => {
      const winner = e.winner_variant_id ? winnerById.get(e.winner_variant_id) : null;
      return {
        id: e.id,
        status: e.status as "active" | "complete",
        variant_count: e.variant_count,
        created_at: e.created_at,
        completed_at: e.completed_at,
        parent_post: e.parent_post_id ? parentById.get(e.parent_post_id) ?? null : null,
        winner_post: winner?.post ?? null,
        winner_metrics: winner?.metrics ?? null,
      };
    });
}
