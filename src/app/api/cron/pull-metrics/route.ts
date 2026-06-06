import { NextResponse, type NextRequest } from "next/server";
import { serverEnv } from "@/lib/env";
import { supabaseService } from "@/lib/supabase/service";
import { dispatchMetrics } from "@/lib/social/dispatch";

// Hourly Vercel Cron — pulls fresh metrics for posts shipped in the last 7
// days, across every connected channel. Engagement rate is cached so the
// dashboard + plan signals can query cheaply.
//
// Per-channel notes:
//   - x         : impressions + engagement; engagement_rate computed.
//   - linkedin  : likes + comments only on personal posts (w_member_social);
//                 impressions/shares are 0 until org-page scope lands.
//   - threads   : views, likes, replies, reposts, quotes.
//   - instagram : impressions/reach, likes, comments, shares, saves.
//   - bluesky   : likes, reposts, quotes, replies (no impressions in API).
//
// Failures on a single post are logged into `results` but do not abort the
// batch — every channel helper either returns zeros or throws a typed
// error and the loop swallows it.

// LinkedIn posts use the URN shape (urn:li:share:... / urn:li:ugcPost:...).
// Anything else stored as external_id is a leftover from a pre-URN code
// path; skip rather than 400 against the metrics endpoint.
function looksLikeLinkedInUrn(id: string): boolean {
  return id.startsWith("urn:li:");
}

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

  // Batch-fetch credentials for every distinct account in this batch once,
  // instead of a per-post serial round-trip (N+1). Keyed by account id so the
  // in-loop lookup is O(1) and preserves the "account missing" semantics — a
  // post whose social_account_id is null/unknown simply misses the map.
  const accountIds = Array.from(
    new Set((posts ?? []).map((p) => p.social_account_id).filter((id): id is string => !!id)),
  );
  const accountById = new Map<string, { credentials: unknown }>();
  if (accountIds.length > 0) {
    const { data: accounts } = await svc
      .from("social_accounts")
      .select("id, credentials")
      .in("id", accountIds);
    for (const a of accounts ?? []) {
      accountById.set(a.id, { credentials: a.credentials });
    }
  }

  const results: Array<{ id: string; ok: boolean; reason?: string }> = [];

  for (const post of posts ?? []) {
    if (!post.external_id) continue;

    // Defensive: LinkedIn external_ids must be URNs; the metrics endpoint
    // returns 400 on anything else. Skip with a reason instead of letting
    // the dispatcher throw a noisy error.
    if (post.channel === "linkedin" && !looksLikeLinkedInUrn(post.external_id)) {
      results.push({ id: post.id, ok: false, reason: "linkedin external_id not a URN" });
      continue;
    }

    const account = post.social_account_id
      ? accountById.get(post.social_account_id)
      : undefined;
    if (!account) {
      results.push({ id: post.id, ok: false, reason: "account missing" });
      continue;
    }

    try {
      const m = await dispatchMetrics(
        svc,
        post.channel,
        account.credentials,
        post.external_id,
        post.social_account_id,
      );
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
