import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { serverEnv, siteUrl } from "@/lib/env";
import { supabaseService } from "@/lib/supabase/service";
import {
  renderEngagementReport,
  type ChannelEngagement,
  type TopPost,
} from "@/lib/email/engagement-report-template";

// End-of-day engagement report. Triggered daily (end of day) from
// .github/workflows/cron-engagement-report.yml; auth via Bearer CRON_SECRET
// (mirrors the other cron routes). For each workspace that published posts in
// the trailing window, aggregates the latest per-post metrics into a
// per-channel rollup and emails the owner one summary via Resend. Workspaces
// with no published posts in the window are skipped (no empty emails).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESEND_URL = "https://api.resend.com/emails";
const WINDOW_DAYS = 7; // trailing rollup window; daily cadence keeps it fresh

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}

function authorized(req: NextRequest): boolean {
  const env = serverEnv();
  const header = req.headers.get("authorization") ?? "";
  if (env.CRON_SECRET && header === `Bearer ${env.CRON_SECRET}`) return true;
  const qs = req.nextUrl.searchParams.get("secret");
  return Boolean(env.CRON_SECRET) && qs === env.CRON_SECRET;
}

interface MetricRow {
  post_id: string;
  fetched_at: string;
  impressions: number | null;
  likes: number | null;
  reposts: number | null;
  replies: number | null;
  engagement_rate: number | null;
}

interface PostRow {
  id: string;
  workspace_id: string;
  channel: string;
  text: string;
}

export async function handle(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const env = serverEnv();
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
    return NextResponse.json(
      { error: "email transport not configured (need RESEND_API_KEY + EMAIL_FROM)" },
      { status: 200 },
    );
  }

  const base = siteUrl();
  const svc = supabaseService();
  const windowStart = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const dateLabel = new Date().toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  // 1. Posts published in the window.
  const { data: posts, error: postErr } = await svc
    .from("posts")
    .select("id, workspace_id, channel, text, scheduled_at")
    .eq("status", "posted")
    .gte("scheduled_at", windowStart);
  if (postErr) {
    return NextResponse.json({ error: postErr.message }, { status: 500 });
  }
  const postRows = (posts ?? []) as Array<PostRow & { scheduled_at: string | null }>;
  if (postRows.length === 0) {
    return NextResponse.json({ checked: 0, sent: 0, reason: "no posted content in window" });
  }

  // 2. Latest metric per post (one query, reduce to newest fetched_at per post).
  const postIds = postRows.map((p) => p.id);
  const { data: metrics, error: metricErr } = await svc
    .from("post_metrics")
    .select("post_id, fetched_at, impressions, likes, reposts, replies, engagement_rate")
    .in("post_id", postIds)
    .order("fetched_at", { ascending: false });
  if (metricErr) {
    return NextResponse.json({ error: metricErr.message }, { status: 500 });
  }
  const latestByPost = new Map<string, MetricRow>();
  for (const m of (metrics ?? []) as MetricRow[]) {
    if (!latestByPost.has(m.post_id)) latestByPost.set(m.post_id, m); // first = newest (desc order)
  }

  const engagementOf = (m: MetricRow | undefined) =>
    (m?.likes ?? 0) + (m?.replies ?? 0) + (m?.reposts ?? 0);

  // 3. Group per workspace → per channel.
  interface ChannelAcc {
    posts: number;
    impressions: number;
    engagements: number;
    rateSum: number;
    rateN: number;
  }
  interface WsAcc {
    channels: Map<string, ChannelAcc>;
    top: TopPost | null;
    topScore: number;
  }
  const byWorkspace = new Map<string, WsAcc>();

  for (const p of postRows) {
    const m = latestByPost.get(p.id);
    const impr = m?.impressions ?? 0;
    const eng = engagementOf(m);

    let ws = byWorkspace.get(p.workspace_id);
    if (!ws) {
      ws = { channels: new Map(), top: null, topScore: -1 };
      byWorkspace.set(p.workspace_id, ws);
    }
    let ch = ws.channels.get(p.channel);
    if (!ch) {
      ch = { posts: 0, impressions: 0, engagements: 0, rateSum: 0, rateN: 0 };
      ws.channels.set(p.channel, ch);
    }
    ch.posts += 1;
    ch.impressions += impr;
    ch.engagements += eng;
    if (m?.engagement_rate != null) {
      ch.rateSum += Number(m.engagement_rate);
      ch.rateN += 1;
    }
    // Top post by engagement, then impressions as tiebreak.
    const score = eng * 1_000_000 + impr;
    if (score > ws.topScore) {
      ws.topScore = score;
      ws.top = { channel: p.channel, text: p.text, impressions: impr, engagements: eng };
    }
  }

  // 4. Look up workspace names + owners, render, send.
  const { data: wsRows, error: wsErr } = await svc
    .from("workspaces")
    .select("id, name, owner_id")
    .in("id", Array.from(byWorkspace.keys()));
  if (wsErr) {
    return NextResponse.json({ error: wsErr.message }, { status: 500 });
  }

  let sent = 0;
  const results: Array<{ workspaceId: string; status: string; reason?: string }> = [];

  for (const ws of wsRows ?? []) {
    const acc = byWorkspace.get(ws.id);
    if (!acc) continue;

    const channels: ChannelEngagement[] = Array.from(acc.channels.entries())
      .map(([channel, c]) => ({
        channel,
        posts: c.posts,
        impressions: c.impressions,
        engagements: c.engagements,
        engagementRate: c.rateN > 0 ? c.rateSum / c.rateN : null,
      }))
      .sort((a, b) => b.engagements - a.engagements);

    const totals = channels.reduce(
      (t, c) => ({
        posts: t.posts + c.posts,
        impressions: t.impressions + c.impressions,
        engagements: t.engagements + c.engagements,
      }),
      { posts: 0, impressions: 0, engagements: 0 },
    );

    const { data: userResp, error: userErr } = await svc.auth.admin.getUserById(ws.owner_id);
    if (userErr || !userResp?.user?.email) {
      results.push({ workspaceId: ws.id, status: "skipped", reason: userErr?.message ?? "owner has no email" });
      continue;
    }
    const recipient = userResp.user.email;

    const html = renderEngagementReport({
      workspaceName: ws.name,
      dateLabel,
      windowDays: WINDOW_DAYS,
      channels,
      totals,
      topPost: acc.top,
      dashboardUrl: `${base}/dashboard`,
      analyticsUrl: `${base}/analytics`,
    });

    try {
      const resp = await fetch(RESEND_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: env.EMAIL_FROM,
          to: recipient,
          subject: `Your daily engagement report — ${ws.name}`,
          html,
        }),
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        results.push({ workspaceId: ws.id, status: "failed", reason: `resend ${resp.status}: ${errText.slice(0, 200)}` });
      } else {
        sent += 1;
        results.push({ workspaceId: ws.id, status: "sent" });
      }
    } catch (err) {
      // Capture the error to Sentry so silently-broken crons are visible. Graceful
      // no-op when SENTRY_DSN is unset.
      Sentry.captureException(err, {
        tags: { cron: "engagement-report", workspace_id: ws.id },
      });
      results.push({ workspaceId: ws.id, status: "failed", reason: err instanceof Error ? err.message : "fetch failed" });
    }
  }

  return NextResponse.json({ checked: byWorkspace.size, sent, results });
}
