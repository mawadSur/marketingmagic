import { supabaseService } from "@/lib/supabase/service";
import { postPublicUrl } from "@/lib/social/post-url";

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
  // Public, human-clickable permalink to the live post on the platform, built
  // from channel + external_id (+ handle). null when we can't form a real link
  // (e.g. never published, or a channel whose id doesn't map to a web URL) — the
  // UI then renders plain text instead of a dead link.
  live_url: string | null;
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
    external_id: string | null;
    social_account_id: string | null;
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
      "post_id, impressions, likes, reposts, replies, engagement_rate, fetched_at, posts!inner(id, workspace_id, text, channel, theme, posted_at, external_id, social_account_id)",
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

// Resolve account handles (needed to build platform permalinks) for a set of
// social_account_ids, in one trip. Best-effort: a missing/failed lookup just
// yields no handle, which degrades a permalink to null (plain text), never an
// error. Reads social_accounts_safe — the handle is non-sensitive.
async function loadHandlesByAccount(
  accountIds: Array<string | null>,
): Promise<Map<string, string>> {
  const ids = Array.from(new Set(accountIds.filter((id): id is string => Boolean(id))));
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  const svc = supabaseService();
  const { data } = await svc.from("social_accounts_safe").select("id, handle").in("id", ids);
  for (const a of (data ?? []) as Array<{ id: string; handle: string | null }>) {
    if (a.handle) map.set(a.id, a.handle);
  }
  return map;
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
  // Carry external_id + social_account_id alongside the display fields so we can
  // build a "view live" permalink AFTER ranking (only for the few posts we show).
  type RankedRow = Omit<TopPost, "live_url"> & {
    external_id: string | null;
    social_account_id: string | null;
  };
  const rows: RankedRow[] = latest
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
      external_id: r.posts!.external_id,
      social_account_id: r.posts!.social_account_id,
    }));
  const sorted = rows
    .filter((r) => r.engagement_rate !== null)
    .sort((a, b) => (b.engagement_rate ?? 0) - (a.engagement_rate ?? 0));
  const top = sorted.slice(0, n);
  const bottom = sorted.slice(-n).reverse();

  // Resolve handles only for the posts we'll actually render, then mint a public
  // permalink per post (null when one can't be formed → UI shows plain text).
  const handleByAccount = await loadHandlesByAccount(
    [...top, ...bottom].map((r) => r.social_account_id),
  );
  const withLink = (r: RankedRow): TopPost => {
    const { external_id, social_account_id, ...rest } = r;
    const handle = social_account_id ? handleByAccount.get(social_account_id) ?? null : null;
    return { ...rest, live_url: postPublicUrl(r.channel, external_id, handle) };
  };

  return {
    top: top.map(withLink),
    bottom: bottom.map(withLink),
  };
}
