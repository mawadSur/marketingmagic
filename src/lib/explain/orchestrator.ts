import { supabaseService } from "@/lib/supabase/service";
import { findDashboardOutliers, type OutlierPost } from "@/lib/explain/outliers";
import { loadWorkspaceContext, themeLift } from "@/lib/explain/context";
import { buildSignals, generateExplainer } from "@/lib/explain/extract";
import {
  explainerCardSchema,
  type ExplainerCard,
} from "@/lib/explain/schema";

export interface CardForRender {
  post: OutlierPost;
  card: ExplainerCard;
}

// Cap how many cards the dashboard will populate per render. Each card is
// one Claude call if not cached — keep it tight to avoid surprise spend.
const DEFAULT_DASHBOARD_LIMIT = 2;

// Render-time orchestration. Pulls outliers, hydrates cards from the
// posts.explainer cache, calls Claude for any uncached ones, persists the
// result so subsequent renders are free, and returns the structured list.
export async function loadDashboardExplainerCards(
  workspaceId: string,
  limit: number = DEFAULT_DASHBOARD_LIMIT,
): Promise<CardForRender[]> {
  // Pull a few extra outliers as candidates — we may skip some if the cache
  // is missing AND we hit the per-render Claude budget.
  const { outliers } = await findDashboardOutliers(workspaceId, limit * 3);
  if (outliers.length === 0) return [];

  const ctx = await loadWorkspaceContext(workspaceId);
  const cards: CardForRender[] = [];

  for (const post of outliers) {
    if (cards.length >= limit) break;
    const card = await ensureExplainer(workspaceId, post, ctx);
    if (card) cards.push({ post, card });
  }
  return cards;
}

// Single-post variant for /plans/[id]. Uses the same outlier filter so the
// card only renders for posts that actually qualify.
export async function loadPostExplainerCard(
  workspaceId: string,
  postId: string,
): Promise<CardForRender | null> {
  const { findOutliers } = await import("@/lib/explain/outliers");
  const { outliers } = await findOutliers(workspaceId, { postId, limit: 1 });
  if (outliers.length === 0) return null;
  const ctx = await loadWorkspaceContext(workspaceId);
  const card = await ensureExplainer(workspaceId, outliers[0]!, ctx);
  if (!card) return null;
  return { post: outliers[0]!, card };
}

async function ensureExplainer(
  workspaceId: string,
  post: OutlierPost,
  ctx: Awaited<ReturnType<typeof loadWorkspaceContext>>,
): Promise<ExplainerCard | null> {
  // Cache hit?
  if (post.explainer && typeof post.explainer === "object") {
    const parsed = explainerCardSchema.safeParse(post.explainer);
    if (parsed.success) return parsed.data;
    // Cache is corrupt; fall through to regenerate.
  }

  const signals = buildSignals({
    post,
    themeLiftRatio: themeLift(ctx, post.theme),
    workspaceWinnerMedianChars: ctx.winnerMedianChars,
  });

  let card: ExplainerCard;
  try {
    const result = await generateExplainer(signals, post.text);
    card = result.card;
  } catch (err) {
    // Don't break the dashboard if Claude is flaky — just skip this card.
    console.error("[explain] generateExplainer failed", {
      post_id: post.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  // Persist. Use service-role: this is a system write, not a user write.
  const svc = supabaseService();
  await svc
    .from("posts")
    .update({ explainer: card })
    .eq("id", post.id)
    .eq("workspace_id", workspaceId);

  return card;
}
