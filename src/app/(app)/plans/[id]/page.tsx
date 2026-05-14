import Link from "next/link";
import { notFound } from "next/navigation";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { Badge, ChannelBadge, statusBadgeLabel, statusBadgeVariant } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { findOutliers } from "@/lib/explain/outliers";
import { loadWorkspaceContext, themeLift } from "@/lib/explain/context";
import { buildSignals, generateExplainer } from "@/lib/explain/extract";
import { explainerCardSchema, type ExplainerCard } from "@/lib/explain/schema";
import { supabaseService } from "@/lib/supabase/service";
import { WhyThisWinsCard } from "@/components/why-this-wins-card";

export const dynamic = "force-dynamic";

export default async function PlanDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();

  const [planRes, postsRes] = await Promise.all([
    supabase
      .from("posting_plans")
      .select("*")
      .eq("id", id)
      .eq("workspace_id", ws.id)
      .maybeSingle(),
    supabase
      .from("posts")
      .select("id, text, theme, scheduled_at, status, channel")
      .eq("plan_id", id)
      .eq("workspace_id", ws.id)
      .order("scheduled_at", { ascending: true }),
  ]);

  if (!planRes.data) notFound();
  const plan = planRes.data;
  const posts = postsRes.data ?? [];

  // Per-post explainer hydration. We compute outliers across this plan's
  // posts (filtered to status=posted with metrics inside findOutliers) and
  // only render cards for matches. Workspace context is loaded once so we
  // don't N+1 query per post.
  const outlierMap = await loadExplainersForPlanPosts(ws.id, posts.map((p) => p.id));

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <Link
          href="/plans"
          className="inline-flex items-center text-xs text-muted-foreground transition-colors duration-200 hover:text-foreground"
        >
          ← All plans
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <p className="label-eyebrow">Plan</p>
            <h1 className="text-3xl font-semibold tracking-tight">{plan.name}</h1>
          </div>
          <Badge variant={statusBadgeVariant(plan.status)}>{statusBadgeLabel(plan.status)}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          <span className="tabular-nums">
            {plan.start_at.slice(0, 10)} → {plan.end_at.slice(0, 10)}
          </span>
          {" · "}
          {posts.length} {posts.length === 1 ? "post" : "posts"}
          {" · "}
          <Link
            href="/queue"
            className="text-primary underline-offset-4 transition-colors duration-200 hover:underline"
          >
            review in queue →
          </Link>
        </p>
        {plan.generation_prompt ? (
          <p className="rounded-md border bg-muted/40 p-3 text-sm leading-relaxed">
            {plan.generation_prompt}
          </p>
        ) : null}
      </header>

      {posts.length === 0 ? (
        <EmptyState
          icon="doc"
          title="This plan has no posts."
          description="That's unusual — generation may have failed mid-flight. Try regenerating from /plans/new."
        />
      ) : (
        <ul className="divide-y rounded-lg border bg-card">
          {posts.map((p) => {
            const explainer = outlierMap.get(p.id);
            return (
              <li
                key={p.id}
                className="space-y-3 px-4 py-3 text-sm transition-colors duration-200 hover:bg-muted/30"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                  <div className="flex flex-wrap items-center gap-2">
                    <ChannelBadge channel={p.channel} />
                    {p.theme ? <span>#{p.theme}</span> : null}
                    <span className="tabular-nums">
                      {p.scheduled_at?.slice(0, 16).replace("T", " ")}
                    </span>
                  </div>
                  <Badge variant={statusBadgeVariant(p.status)}>{statusBadgeLabel(p.status)}</Badge>
                </div>
                <p className="whitespace-pre-wrap leading-relaxed">{p.text}</p>
                {explainer ? (
                  <WhyThisWinsCard
                    postId={p.id}
                    postText={p.text}
                    channel={p.channel}
                    theme={p.theme}
                    postedAt={explainer.postedAt}
                    engagementRate={explainer.engagementRate}
                    baseline={explainer.baseline}
                    ratio={explainer.ratio}
                    verdict={explainer.verdict}
                    card={explainer.card}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

interface ExplainerHydration {
  card: ExplainerCard;
  postedAt: string;
  engagementRate: number;
  baseline: number;
  ratio: number;
  verdict: "winner" | "underperformer";
}

// Loads explainer cards for every post in the plan that qualifies as an
// outlier. Each cached card comes from posts.explainer; uncached qualifying
// posts trigger a single Claude call apiece, then persist. Failures are
// silenced (the post just renders without a card) so plan view never breaks.
async function loadExplainersForPlanPosts(
  workspaceId: string,
  postIds: string[],
): Promise<Map<string, ExplainerHydration>> {
  const out = new Map<string, ExplainerHydration>();
  if (postIds.length === 0) return out;

  // findOutliers without postId returns ALL outliers in the 28d window.
  // Filter to this plan's post set.
  const { outliers } = await findOutliers(workspaceId, { limit: 200 });
  const inPlan = outliers.filter((o) => postIds.includes(o.id));
  if (inPlan.length === 0) return out;

  const ctx = await loadWorkspaceContext(workspaceId);
  const svc = supabaseService();

  for (const post of inPlan) {
    let card: ExplainerCard | null = null;
    if (post.explainer && typeof post.explainer === "object") {
      const parsed = explainerCardSchema.safeParse(post.explainer);
      if (parsed.success) card = parsed.data;
    }
    if (!card) {
      try {
        const signals = buildSignals({
          post,
          themeLiftRatio: themeLift(ctx, post.theme),
          workspaceWinnerMedianChars: ctx.winnerMedianChars,
        });
        const result = await generateExplainer(signals, post.text);
        card = result.card;
        await svc
          .from("posts")
          .update({ explainer: card })
          .eq("id", post.id)
          .eq("workspace_id", workspaceId);
      } catch (err) {
        console.error("[plan-detail] explainer failed", {
          post_id: post.id,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
    }
    out.set(post.id, {
      card,
      postedAt: post.posted_at,
      engagementRate: post.engagement_rate,
      baseline: post.baseline,
      ratio: post.ratio,
      verdict: post.verdict,
    });
  }
  return out;
}
