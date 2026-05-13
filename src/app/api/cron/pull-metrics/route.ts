import { NextResponse, type NextRequest } from "next/server";
import { serverEnv } from "@/lib/env";
import { supabaseService } from "@/lib/supabase/service";
import { dispatchMetrics } from "@/lib/social/dispatch";

// Hourly Vercel Cron — pulls fresh metrics for posts shipped in the last 7
// days, across every connected channel. Engagement rate is cached so the
// dashboard + plan signals can query cheaply.

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
      const m = await dispatchMetrics(post.channel, account.credentials, post.external_id);
      const engaged = m.likes + m.comments + m.shares;
      const engagement_rate = m.impressions > 0 ? engaged / m.impressions : null;

      const { error: insErr } = await svc.from("post_metrics").insert({
        post_id: post.id,
        impressions: m.impressions,
        likes: m.likes,
        reposts: m.shares,
        replies: m.comments,
        clicks: m.clicks,
        engagement_rate,
        raw: m as unknown as Record<string, number>,
      });
      if (insErr) throw new Error(insErr.message);

      results.push({ id: post.id, ok: true });
    } catch (err) {
      results.push({ id: post.id, ok: false, reason: err instanceof Error ? err.message : "unknown" });
    }

    // Polite pacing — most platforms have read quotas.
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
