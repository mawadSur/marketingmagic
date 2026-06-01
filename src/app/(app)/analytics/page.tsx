import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import {
  getEngagementByDay,
  getStatsByChannel,
  getTopAndBottomPosts,
} from "@/lib/dashboard/analytics";
import { getOrGenerateAiReview } from "@/lib/dashboard/ai-review";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChannelBadge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { EngagementChart } from "./engagement-chart";
import { SectionLinks } from "@/components/ui/section-links";
import { hasCompetitorWatch } from "@/lib/billing/tiers";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  const ws = await getActiveWorkspaceOrRedirect();

  const [byDay, byChannel, ranked, review] = await Promise.all([
    getEngagementByDay(ws.id, 30),
    getStatsByChannel(ws.id, 30),
    getTopAndBottomPosts(ws.id, 30, 5),
    getOrGenerateAiReview(ws.id, 30).catch(() => null),
  ]);

  const totals = byChannel.reduce(
    (acc, c) => ({
      posts: acc.posts + c.posts,
      impressions: acc.impressions + c.impressions,
      engagement: acc.engagement + c.engagement,
    }),
    { posts: 0, impressions: 0, engagement: 0 },
  );
  const avgRate = totals.impressions > 0 ? totals.engagement / totals.impressions : 0;

  // Competitors + Portfolio were pulled out of the top nav; surface them here
  // (Competitors is Founder-tier-gated).
  const insightLinks = [
    ...(hasCompetitorWatch(ws.plan) ? [{ href: "/competitors", label: "Competitors" }] : []),
    { href: "/portfolio", label: "Portfolio" },
    { href: "/analytics/themes", label: "Themes" },
  ];

  return (
    <div className="space-y-10">
      <header className="space-y-1">
        <p className="label-eyebrow">Last 30 days</p>
        <h1 className="text-3xl font-semibold tracking-tight">Analytics</h1>
        <p className="text-sm text-muted-foreground">
          Aggregated across every connected channel. Metrics refresh hourly.
        </p>
      </header>

      <SectionLinks links={insightLinks} />

      <section className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-4">
        <Kpi label="Posts" value={totals.posts.toLocaleString()} />
        <Kpi label="Impressions" value={totals.impressions.toLocaleString()} />
        <Kpi label="Engagements" value={totals.engagement.toLocaleString()} />
        <Kpi label="Avg engagement rate" value={`${(avgRate * 100).toFixed(2)}%`} />
      </section>

      <section className="space-y-3">
        <div className="flex items-end justify-between">
          <div>
            <p className="label-eyebrow">Trend</p>
            <h2 className="text-base font-medium">Engagement over time</h2>
          </div>
        </div>
        <Card>
          <CardContent className="pt-5 sm:pt-6">
            <EngagementChart data={byDay} />
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-3">
          <div>
            <p className="label-eyebrow">Breakdown</p>
            <h2 className="text-base font-medium">By channel</h2>
          </div>
          {byChannel.length === 0 ? (
            <EmptyState
              icon="chart"
              title="Nothing's posted in the last 30 days."
              description="Once your scheduled drafts go live, channel stats land here."
            />
          ) : (
            <ul className="divide-y rounded-lg border bg-card">
              {byChannel.map((c) => {
                const pct = c.engagement_rate * 100;
                return (
                  <li
                    key={c.channel}
                    className="flex items-center justify-between gap-3 px-4 py-3 text-sm transition-colors duration-200 hover:bg-muted/30"
                  >
                    <div className="flex items-center gap-3">
                      <ChannelBadge channel={c.channel} />
                      <span className="text-muted-foreground">{c.posts} posts</span>
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-2 tabular-nums sm:gap-3">
                      <span className="text-muted-foreground">
                        {c.impressions.toLocaleString()} <span className="hidden sm:inline">impressions</span>
                      </span>
                      <span className="font-medium">{pct.toFixed(2)}%</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="space-y-3">
          <div>
            <p className="label-eyebrow">Weekly AI review</p>
            <h2 className="text-base font-medium">Summary</h2>
          </div>
          {review === null ? (
            <EmptyState
              icon="doc"
              title="Need a few more posts."
              description="Claude writes a review once you've shipped at least 5 posts in the window."
            />
          ) : (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Summary</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p>{review.summary}</p>
                {review.themes_worked.length > 0 ? (
                  <ReviewList title="What worked" items={review.themes_worked} tone="positive" />
                ) : null}
                {review.themes_struggled.length > 0 ? (
                  <ReviewList title="What struggled" items={review.themes_struggled} tone="negative" />
                ) : null}
                {review.timing_suggestions.length > 0 ? (
                  <ReviewList title="Timing" items={review.timing_suggestions} />
                ) : null}
                {review.next_actions.length > 0 ? (
                  <ReviewList title="Next actions" items={review.next_actions} />
                ) : null}
                <p className="label-eyebrow">
                  Generated {review.generated_at.slice(0, 10)}
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <PostList title="Top posts" emptyIcon="spark" emptyTitle="Top posts will surface here." posts={ranked.top} />
        <PostList
          title="Needs work"
          emptyIcon="chart"
          emptyTitle="Nothing flagged yet."
          posts={ranked.bottom}
        />
      </section>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <Card className="surface-kpi">
      <CardHeader className="pb-2">
        <CardTitle className="label-eyebrow">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tabular-nums sm:text-3xl">{value}</div>
      </CardContent>
    </Card>
  );
}

function ReviewList({
  title,
  items,
  tone,
}: {
  title: string;
  items: string[];
  tone?: "positive" | "negative";
}) {
  const cls =
    tone === "positive"
      ? "border-l-2 border-emerald-500/60 pl-3"
      : tone === "negative"
      ? "border-l-2 border-amber-500/60 pl-3"
      : "border-l-2 border-muted-foreground/30 pl-3";
  return (
    <div className={cls}>
      <p className="label-eyebrow">{title}</p>
      <ul className="mt-1 list-disc space-y-1 pl-4">
        {items.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
    </div>
  );
}

interface PostLike {
  id: string;
  text: string;
  channel: string;
  theme: string | null;
  posted_at: string | null;
  impressions: number;
  engagement_rate: number | null;
}

function PostList({
  title,
  posts,
  emptyTitle,
  emptyIcon,
}: {
  title: string;
  posts: PostLike[];
  emptyTitle: string;
  emptyIcon: "spark" | "chart";
}) {
  return (
    <div className="space-y-3">
      <div>
        <p className="label-eyebrow">Ranked</p>
        <h2 className="text-base font-medium">{title}</h2>
      </div>
      {posts.length === 0 ? (
        <EmptyState icon={emptyIcon} title={emptyTitle} description="Waiting for posted-and-measured posts in the window." />
      ) : (
        <ul className="divide-y rounded-lg border bg-card">
          {posts.map((p) => (
            <li
              key={p.id}
              className="space-y-1 px-4 py-3 text-sm transition-colors duration-200 hover:bg-muted/30"
            >
              <p className="line-clamp-2 font-medium">{p.text}</p>
              <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <ChannelBadge channel={p.channel} />
                {p.theme ? <span>#{p.theme}</span> : null}
                <span aria-hidden>·</span>
                <span>{p.impressions.toLocaleString()} impressions</span>
                <span aria-hidden>·</span>
                <span className="font-medium tabular-nums">{((p.engagement_rate ?? 0) * 100).toFixed(2)}%</span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
