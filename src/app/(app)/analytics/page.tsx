import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import {
  getEngagementByDay,
  getStatsByChannel,
  getTopAndBottomPosts,
} from "@/lib/dashboard/analytics";
import { getOrGenerateAiReview } from "@/lib/dashboard/ai-review";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EngagementChart } from "./engagement-chart";
import { CHANNELS } from "@/lib/channels/registry";

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

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
        <p className="text-sm text-muted-foreground">Last 30 days across all connected channels.</p>
      </header>

      <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Kpi label="Posts" value={totals.posts.toLocaleString()} />
        <Kpi label="Impressions" value={totals.impressions.toLocaleString()} />
        <Kpi label="Engagements" value={totals.engagement.toLocaleString()} />
        <Kpi label="Avg engagement rate" value={`${(avgRate * 100).toFixed(2)}%`} />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Engagement over time</h2>
        <Card>
          <CardContent className="pt-4">
            <EngagementChart data={byDay} />
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-3">
          <h2 className="text-sm font-medium">By channel</h2>
          {byChannel.length === 0 ? (
            <p className="rounded-lg border p-4 text-sm text-muted-foreground">
              No posts in the window yet.
            </p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {byChannel.map((c) => {
                const label = CHANNELS[c.channel as keyof typeof CHANNELS]?.label ?? c.channel;
                const pct = c.engagement_rate * 100;
                return (
                  <li key={c.channel} className="flex items-center justify-between px-4 py-3 text-sm">
                    <div className="flex items-center gap-3">
                      <span className="rounded-md border px-2 py-0.5 text-xs uppercase">{label}</span>
                      <span className="text-muted-foreground">{c.posts} posts</span>
                    </div>
                    <div className="flex items-center gap-3 tabular-nums">
                      <span>{c.impressions.toLocaleString()} impressions</span>
                      <span className="font-medium">{pct.toFixed(2)}%</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="space-y-3">
          <h2 className="text-sm font-medium">AI review (weekly)</h2>
          {review === null ? (
            <p className="rounded-lg border p-4 text-sm text-muted-foreground">
              Need at least 5 posts in the window to generate a review.
            </p>
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
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Generated {review.generated_at.slice(0, 10)}
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <PostList title="Top posts" posts={ranked.top} />
        <PostList title="Worst posts" posts={ranked.bottom} />
      </section>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
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
      ? "border-l-2 border-emerald-500/50 pl-3"
      : tone === "negative"
      ? "border-l-2 border-amber-500/50 pl-3"
      : "border-l-2 border-muted pl-3";
  return (
    <div className={cls}>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
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

function PostList({ title, posts }: { title: string; posts: PostLike[] }) {
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-medium">{title}</h2>
      {posts.length === 0 ? (
        <p className="rounded-lg border p-4 text-sm text-muted-foreground">No posts yet.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {posts.map((p) => (
            <li key={p.id} className="space-y-1 px-4 py-3 text-sm">
              <p className="line-clamp-2 font-medium">{p.text}</p>
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="rounded-md border px-1.5 py-0.5 uppercase">{p.channel}</span>
                {p.theme ? <span>#{p.theme}</span> : null}
                <span>·</span>
                <span>{p.impressions.toLocaleString()} impressions</span>
                <span>·</span>
                <span>{((p.engagement_rate ?? 0) * 100).toFixed(2)}%</span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
