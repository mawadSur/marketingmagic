import Link from "next/link";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { isCompetitorWatchEnabled } from "@/lib/billing/feature-gates";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { loadCompetitorState, removeWatchHandleAction, useWinnerAsSourceAction } from "./actions";
import type { Database, CompetitorWatchChannel } from "@/lib/db/types";
import { isCompetitorChannelSupported } from "@/lib/competitors/schema";

export const dynamic = "force-dynamic";

type WatchHandleRow = Database["public"]["Tables"]["watch_handles"]["Row"];
type CompetitorPostRow = Database["public"]["Tables"]["competitor_posts"]["Row"];

export default async function CompetitorsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ws = await getActiveWorkspaceOrRedirect();
  const sp = await searchParams;
  const errorParam = typeof sp.error === "string" ? sp.error : null;

  if (!isCompetitorWatchEnabled(ws.plan)) {
    return (
      <div className="space-y-8">
        <header className="space-y-1">
          <p className="label-eyebrow">Competitor Watch</p>
          <h1 className="text-3xl font-semibold tracking-tight">Competitors</h1>
          <p className="text-sm text-muted-foreground">
            Per-workspace watch list. Daily pulls. Pattern extraction on winners. Premium-tier feature.
          </p>
        </header>
        <EmptyState
          icon="spark"
          title="Available on the Founder tier."
          description="Upgrade to track competitor handles, surface winners, and draft constructive responses."
          action={
            <Link
              href="/settings/billing"
              className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity duration-200 hover:opacity-90"
            >
              See plans →
            </Link>
          }
        />
      </div>
    );
  }

  const state = await loadCompetitorState(ws.id);
  const allWinners: Array<{ handle: WatchHandleRow; post: CompetitorPostRow }> = [];
  for (const { handle, recentWinners } of state) {
    for (const post of recentWinners) {
      allWinners.push({ handle, post });
    }
  }
  allWinners.sort(
    (a, b) => +new Date(b.post.posted_at) - +new Date(a.post.posted_at),
  );

  return (
    <div className="space-y-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <p className="label-eyebrow">Competitor Watch</p>
          <h1 className="text-3xl font-semibold tracking-tight">Competitors</h1>
          <p className="text-sm text-muted-foreground">
            Watch lists, daily pulls, and the winners we&apos;ve flagged. Read-only.
          </p>
        </div>
        <Link
          href="/competitors/add"
          className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity duration-200 hover:opacity-90"
        >
          Add a handle
        </Link>
      </header>

      {errorParam ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {errorMessage(errorParam)}
        </div>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">Watch list</h2>
        {state.length === 0 ? (
          <EmptyState
            icon="inbox"
            title="No handles watched yet."
            description="Add a handle and we'll start pulling tomorrow morning at 12:00 UTC."
            action={
              <Link
                href="/competitors/add"
                className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity duration-200 hover:opacity-90"
              >
                Add your first handle
              </Link>
            }
          />
        ) : (
          <ul className="divide-y rounded-lg border bg-card">
            {state.map(({ handle, recentWinners }) => (
              <li key={handle.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <p className="flex items-center gap-2 font-medium">
                    <Badge variant="muted">{channelLabel(handle.channel as CompetitorWatchChannel)}</Badge>
                    <span className="truncate">{handle.handle}</span>
                    {handle.display_name ? (
                      <span className="truncate text-sm text-muted-foreground">({handle.display_name})</span>
                    ) : null}
                    <StatusBadge handle={handle} />
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {recentWinners.length} winner{recentWinners.length === 1 ? "" : "s"} ·{" "}
                    {handle.last_pulled_at
                      ? `last pulled ${humanAgo(handle.last_pulled_at)}`
                      : "not pulled yet"}
                    {handle.failure_reason ? ` · ${handle.failure_reason}` : ""}
                  </p>
                </div>
                <form action={removeWatchHandleAction}>
                  <input type="hidden" name="id" value={handle.id} />
                  <button
                    type="submit"
                    className="rounded-md border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-destructive"
                  >
                    Stop watching
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">Recent winners</h2>
        {allWinners.length === 0 ? (
          <EmptyState
            icon="chart"
            title="No winners yet."
            description="Once we have at least 8 cached posts per handle we'll flag the top 10% as winners and tag the pattern."
          />
        ) : (
          <ul className="space-y-3">
            {allWinners.slice(0, 30).map(({ handle, post }) => (
              <li key={post.id} className="rounded-lg border bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-2">
                    <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant="muted">{channelLabel(handle.channel as CompetitorWatchChannel)}</Badge>
                      <span className="font-medium text-foreground">{handle.handle}</span>
                      <span>·</span>
                      <span>{new Date(post.posted_at).toISOString().slice(0, 10)}</span>
                      {post.engagement_rate != null ? (
                        <>
                          <span>·</span>
                          <span className="tabular-nums">{formatEngagement(post.engagement_rate)}</span>
                        </>
                      ) : null}
                    </p>
                    <p className="text-sm leading-relaxed">{post.text}</p>
                    {post.pattern_tags && post.pattern_tags.length > 0 ? (
                      <div className="flex flex-wrap items-center gap-1.5">
                        {post.pattern_tags.map((tag) => (
                          <Badge key={tag} variant="muted">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    ) : null}
                    {post.pattern_reason ? (
                      <p className="text-xs italic text-muted-foreground">
                        Possible reason: {post.pattern_reason}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-2">
                    {post.post_url ? (
                      <a
                        href={post.post_url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-muted-foreground underline-offset-4 hover:underline"
                      >
                        Source ↗
                      </a>
                    ) : null}
                    <form action={useWinnerAsSourceAction}>
                      <input type="hidden" name="competitor_post_id" value={post.id} />
                      <button
                        type="submit"
                        title="Draft a constructive response (not a takedown). Anti-harassment by design."
                        disabled={post.drafted_at != null}
                        className="rounded-md border bg-background px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {post.drafted_at ? "Drafted" : "Draft response"}
                      </button>
                    </form>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function errorMessage(code: string): string {
  switch (code) {
    case "no_brief":
      return "Write a brand brief first — it powers the response generator.";
    case "not_found":
      return "Couldn't find that winner — it may have been removed.";
    case "seed_failed":
      return "Couldn't seed the source. Try again or open an issue.";
    case "tier_gated":
      return "Counter-content is available on the Founder tier.";
    case "missing_id":
      return "Missing winner id.";
    default:
      return code;
  }
}

function StatusBadge({ handle }: { handle: WatchHandleRow }) {
  const channel = handle.channel as CompetitorWatchChannel;
  if (!isCompetitorChannelSupported(channel)) {
    return <Badge variant="muted">coming soon</Badge>;
  }
  switch (handle.status) {
    case "active":
      return null;
    case "rate_limited":
      return <Badge variant="muted">rate-limited</Badge>;
    case "failed":
      return <Badge variant="muted">failed</Badge>;
    case "paused":
      return <Badge variant="muted">paused</Badge>;
    default:
      return null;
  }
}

function channelLabel(channel: CompetitorWatchChannel): string {
  switch (channel) {
    case "x":
      return "X";
    case "bluesky":
      return "Bluesky";
    case "linkedin":
      return "LinkedIn";
    case "instagram":
      return "Instagram";
    case "threads":
      return "Threads";
  }
}

function formatEngagement(rate: number): string {
  if (rate < 1) return `${(rate * 100).toFixed(2)}%`;
  return `${Math.round(rate)} eng`;
}

function humanAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const h = Math.floor(ms / (60 * 60 * 1000));
  if (h < 1) return "just now";
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
