import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import {
  getEngagementByDay,
  getStatsByChannel,
  getTopAndBottomPosts,
} from "@/lib/dashboard/analytics";
import { getOrGenerateAiReview } from "@/lib/dashboard/ai-review";
import {
  computeThemeOutcomes,
  formatCents,
  type ThemeOutcomeReport,
  type ThemeOutcomeStat,
} from "@/lib/analytics/outcomes";
import { OUTCOME_TYPES, OUTCOME_TYPE_LABELS } from "@/lib/analytics/outcome-schema";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChannelBadge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { EngagementChart } from "./engagement-chart";
import { MarkOutcome } from "./mark-outcome";
import { SectionLinks } from "@/components/ui/section-links";
import { hasCompetitorWatch } from "@/lib/billing/tiers";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  const ws = await getActiveWorkspaceOrRedirect();

  const [byDay, byChannel, ranked, review, outcomes] = await Promise.all([
    getEngagementByDay(ws.id, 30),
    getStatsByChannel(ws.id, 30),
    getTopAndBottomPosts(ws.id, 30, 5),
    getOrGenerateAiReview(ws.id, 30).catch(() => null),
    computeThemeOutcomes(ws.id).catch(
      (): ThemeOutcomeReport => ({
        hasOutcomes: false,
        themes: [],
        totalOutcomes: 0,
        totalRevenueCents: 0,
      }),
    ),
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
                      <span className="tabular-nums text-muted-foreground">
                        {c.impressions.toLocaleString()} <span className="hidden sm:inline">impressions</span>
                      </span>
                      <span className="font-medium tabular-nums">{pct.toFixed(2)}%</span>
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

      <ThemeOutcomes report={outcomes} />
    </div>
  );
}

// Outcome Loop MVP (Bet 1) — revenue-ranked themes. Ranks themes by the
// business outcomes users self-report on posts, not just engagement. Cold
// start (no outcomes tagged) renders an explicit prompt, never an empty table.
function ThemeOutcomes({ report }: { report: ThemeOutcomeReport }) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="label-eyebrow">Outcome loop</p>
          <h2 className="text-base font-medium">Themes by outcome · $ per theme</h2>
          <p className="text-sm text-muted-foreground">
            Ranked by the leads, sales, signups, and bookings you tag on posts —
            not just engagement.
          </p>
        </div>
        {report.hasOutcomes ? (
          <div className="flex items-center gap-4 text-sm">
            <span className="tabular-nums">
              <span className="font-semibold">{formatCents(report.totalRevenueCents)}</span>{" "}
              <span className="text-muted-foreground">tagged revenue</span>
            </span>
            <span className="tabular-nums">
              <span className="font-semibold">{report.totalOutcomes.toLocaleString()}</span>{" "}
              <span className="text-muted-foreground">outcomes</span>
            </span>
          </div>
        ) : null}
      </div>

      {!report.hasOutcomes ? (
        <EmptyState
          icon="spark"
          title="No outcomes tagged yet."
          description="Tag a few posts with the lead, sale, signup, or booking they drove — then this ranks your themes by results, not just engagement. Use “Mark outcome” on the posts above."
        />
      ) : (
        <ul className="divide-y rounded-lg border bg-card">
          {report.themes.map((t) => (
            <ThemeOutcomeRow key={t.tag} stat={t} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ThemeOutcomeRow({ stat }: { stat: ThemeOutcomeStat }) {
  // Compact per-type breakdown ("2 sale · 1 lead"), skipping zero buckets.
  const breakdown = OUTCOME_TYPES.filter((t) => stat.by_type[t] > 0)
    .map((t) => `${stat.by_type[t]} ${OUTCOME_TYPE_LABELS[t].toLowerCase()}`)
    .join(" · ");
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3 text-sm transition-colors duration-200 hover:bg-muted/30">
      <div className="min-w-0">
        <p className="truncate font-medium">#{stat.tag}</p>
        <p className="text-xs text-muted-foreground">{breakdown}</p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 tabular-nums sm:gap-3">
        <span className="text-muted-foreground">
          {stat.outcomes.toLocaleString()}{" "}
          <span className="hidden sm:inline">outcome{stat.outcomes === 1 ? "" : "s"}</span>
        </span>
        <span className="font-semibold">{formatCents(stat.revenue_cents)}</span>
      </div>
    </li>
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
              {/* div, not p: MarkOutcome renders a <form> (block content), which
                  is invalid inside a <p> and triggers a React hydration error
                  that breaks the form's submit. */}
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <ChannelBadge channel={p.channel} />
                {p.theme ? <span>#{p.theme}</span> : null}
                <span aria-hidden>·</span>
                <span>{p.impressions.toLocaleString()} impressions</span>
                <span aria-hidden>·</span>
                <span className="font-medium tabular-nums">{((p.engagement_rate ?? 0) * 100).toFixed(2)}%</span>
                <span aria-hidden>·</span>
                <MarkOutcome postId={p.id} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
