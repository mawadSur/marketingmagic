import { NextResponse, type NextRequest } from "next/server";
import { serverEnv } from "@/lib/env";
import { supabaseService } from "@/lib/supabase/service";
import { xMetrics, type XCredentials } from "@/lib/social/x";

// Hourly Vercel Cron — pulls fresh metrics for posts shipped in the last 7 days.
// Engagement rate = (likes + reposts + replies) / max(impressions, 1) and is cached
// in post_metrics.engagement_rate so the dashboard + plan signals can query cheaply.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOOKBACK_HOURS = 24 * 7;
const BATCH = 50;

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}

async function handle(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const svc = supabaseService();
  const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();

  const { data: posts, error } = await svc
    .from("posts")
    .select("id, external_id, social_account_id, channel")
    .eq("status", "posted")
    .eq("channel", "x")
    .gte("posted_at", since)
    .not("external_id", "is", null)
    .limit(BATCH);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const results: Array<{ id: string; ok: boolean; reason?: string }> = [];

  for (const post of posts ?? []) {
    if (!post.external_id) continue;

    const { data: account } = await svc
      .from("social_accounts")
      .select("credentials")
      .eq("id", post.social_account_id)
      .maybeSingle();
    if (!account) {
      results.push({ id: post.id, ok: false, reason: "account missing" });
      continue;
    }

    try {
      const creds = account.credentials as unknown as XCredentials;
      const m = await xMetrics(creds, post.external_id);
      const engaged = m.likes + m.reposts + m.replies;
      const engagement_rate = m.impressions > 0 ? engaged / m.impressions : null;

      const { error: insErr } = await svc.from("post_metrics").insert({
        post_id: post.id,
        impressions: m.impressions,
        likes: m.likes,
        reposts: m.reposts,
        replies: m.replies,
        clicks: m.clicks,
        engagement_rate,
        raw: m as unknown as Record<string, number>,
      });
      if (insErr) throw new Error(insErr.message);

      results.push({ id: post.id, ok: true });
    } catch (err) {
      results.push({ id: post.id, ok: false, reason: err instanceof Error ? err.message : "unknown" });
    }

    // Polite pacing — X v2 free tier has tight read quotas.
    await sleep(250);
  }

  return NextResponse.json({ checked: posts?.length ?? 0, results });
}

function authorized(req: NextRequest): boolean {
  const env = serverEnv();
  const header = req.headers.get("authorization") ?? "";
  if (header === `Bearer ${env.CRON_SECRET}`) return true;
  const qs = req.nextUrl.searchParams.get("secret");
  return qs === env.CRON_SECRET;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
