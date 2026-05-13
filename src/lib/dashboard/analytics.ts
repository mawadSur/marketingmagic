import { supabaseService } from "@/lib/supabase/service";

// Day bucket = YYYY-MM-DD in UTC.
export interface DayBucket {
  day: string;
  posts: number;
  impressions: number;
  engagement: number;
  engagement_rate: number;
}

export interface ChannelStats {
  channel: string;
  posts: number;
  impressions: number;
  engagement: number;
  engagement_rate: number;
}

export interface TopPost {
  id: string;
  text: string;
  channel: string;
  theme: string | null;
  posted_at: string | null;
  impressions: number;
  likes: number;
  shares: number;
  comments: number;
  engagement_rate: number | null;
}

const DAY = 24 * 60 * 60 * 1000;

interface MetricsJoinRow {
  post_id: string;
  impressions: number | null;
  likes: number | null;
  reposts: number | null;
  replies: number | null;
  engagement_rate: number | null;
  posts: {
    id: string;
    workspace_id: string;
    text: string;
    channel: string;
    theme: string | null;
    posted_at: string | null;
  } | null;
}

async function loadRecentMetrics(
  workspaceId: string,
  windowDays: number,
): Promise<MetricsJoinRow[]> {
  const svc = supabaseService();
  const since = new Date(Date.now() - windowDays * DAY).toISOString();

  // Latest metric per post in the window. Order by post_id desc, fetched_at
  // desc and dedupe in code — Supabase doesn't expose DISTINCT ON easily.
  const { data } = await svc
    .from("post_metrics")
    .select(
      "post_id, impressions, likes, reposts, replies, engagement_rate, fetched_at, posts!inner(id, workspace_id, text, channel, theme, posted_at)",
    )
    .eq("posts.workspace_id", workspaceId)
    .gte("posts.posted_at", since)
    .order("fetched_at", { ascending: false })
    .limit(2000);

  const seen = new Set<string>();
  const latest: MetricsJoinRow[] = [];
  for (const row of (data ?? []) as unknown as MetricsJoinRow[]) {
    if (seen.has(row.post_id)) continue;
    seen.add(row.post_id);
    latest.push(row);
  }
  return latest;
}

export async function getEngagementByDay(
  workspaceId: string,
  windowDays = 30,
): Promise<DayBucket[]> {
  const latest = await loadRecentMetrics(workspaceId, windowDays);

  const buckets = new Map<string, DayBucket>();
  // Seed every day so the chart has a continuous x-axis.
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * DAY);
    const key = d.toISOString().slice(0, 10);
    buckets.set(key, { day: key, posts: 0, impressions: 0, engagement: 0, engagement_rate: 0 });
  }

  for (const row of latest) {
    if (!row.posts?.posted_at) continue;
    const day = row.posts.posted_at.slice(0, 10);
    const b = buckets.get(day);
    if (!b) continue;
    b.posts += 1;
    b.impressions += row.impressions ?? 0;
    b.engagement += (row.likes ?? 0) + (row.reposts ?? 0) + (row.replies ?? 0);
  }
  for (const b of buckets.values()) {
    b.engagement_rate = b.impressions > 0 ? b.engagement / b.impressions : 0;
  }

  return Array.from(buckets.values());
}

export async function getStatsByChannel(
  workspaceId: string,
  windowDays = 30,
): Promise<ChannelStats[]> {
  const latest = await loadRecentMetrics(workspaceId, windowDays);
  const map = new Map<string, ChannelStats>();
  for (const row of latest) {
    if (!row.posts) continue;
    const c = row.posts.channel;
    const entry = map.get(c) ?? {
      channel: c,
      posts: 0,
      impressions: 0,
      engagement: 0,
      engagement_rate: 0,
    };
    entry.posts += 1;
    entry.impressions += row.impressions ?? 0;
    entry.engagement += (row.likes ?? 0) + (row.reposts ?? 0) + (row.replies ?? 0);
    map.set(c, entry);
  }
  for (const e of map.values()) {
    e.engagement_rate = e.impressions > 0 ? e.engagement / e.impressions : 0;
  }
  return Array.from(map.values()).sort((a, b) => b.engagement_rate - a.engagement_rate);
}

export async function getTopAndBottomPosts(
  workspaceId: string,
  windowDays = 30,
  n = 5,
): Promise<{ top: TopPost[]; bottom: TopPost[] }> {
  const latest = await loadRecentMetrics(workspaceId, windowDays);
  const rows: TopPost[] = latest
    .filter((r) => r.posts !== null)
    .map((r) => ({
      id: r.posts!.id,
      text: r.posts!.text,
      channel: r.posts!.channel,
      theme: r.posts!.theme,
      posted_at: r.posts!.posted_at,
      impressions: r.impressions ?? 0,
      likes: r.likes ?? 0,
      shares: r.reposts ?? 0,
      comments: r.replies ?? 0,
      engagement_rate: r.engagement_rate,
    }));
  const sorted = rows.filter((r) => r.engagement_rate !== null).sort((a, b) => (b.engagement_rate ?? 0) - (a.engagement_rate ?? 0));
  return {
    top: sorted.slice(0, n),
    bottom: sorted.slice(-n).reverse(),
  };
}
