import { loadDashboardExplainerCards } from "@/lib/explain/orchestrator";
import { WhyThisWinsCard } from "@/components/why-this-wins-card";

// Server component. Mounted into the dashboard page. Renders nothing when
// the workspace has no outliers (most workspaces, most of the time) — we
// intentionally do NOT render a placeholder, because an empty surface is
// less noise than "we couldn't find any outliers" copy.
export async function ExplainSection({ workspaceId }: { workspaceId: string }) {
  // Hard cap at 2 cards per dashboard view (spec requirement).
  const cards = await loadDashboardExplainerCards(workspaceId, 2);
  if (cards.length === 0) return null;

  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between">
        <div>
          <p className="label-eyebrow">Outliers</p>
          <h2 className="text-base font-medium">What stood out</h2>
        </div>
        <p className="text-xs text-muted-foreground">
          Possible reasons, never certainties.
        </p>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {cards.map(({ post, card }) => (
          <WhyThisWinsCard
            key={post.id}
            postId={post.id}
            postText={post.text}
            channel={post.channel}
            theme={post.theme}
            postedAt={post.posted_at}
            engagementRate={post.engagement_rate}
            baseline={post.baseline}
            ratio={post.ratio}
            verdict={post.verdict}
            card={card}
          />
        ))}
      </div>
    </section>
  );
}
