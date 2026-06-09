import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { serverEnv, siteUrl } from "@/lib/env";
import { supabaseService } from "@/lib/supabase/service";
import { signLinkToken } from "@/lib/email/sign";
import { renderDigestEmail, type DigestPost } from "@/lib/email/digest-template";
import { dispatchDigest, type DispatchResult } from "@/lib/integrations/dispatch";
import { findNeglectedThemes } from "@/lib/themes/gaps";
import {
  dispatchNeglectedThemesNotice,
  DIGEST_NEGLECTED_LIMIT,
  type NeglectedNoticeResult,
} from "@/lib/themes/digest-notice";

// Daily approval digest. Runs 14:00 UTC from .github/workflows/cron-email-digest.yml.
// Auth: Bearer CRON_SECRET (same shape as the other cron routes). Service-role
// Supabase client used throughout — RLS would block reads across workspaces.
//
// For each workspace with ≥1 pending_approval post we send one email to the
// owner (workspace.owner_id → auth.users.email) containing up to 10 posts and
// HMAC-signed approve/reject magic links. Resend is called via raw fetch so
// we don't add an SDK dep.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_POSTS_PER_EMAIL = 10;
const RESEND_URL = "https://api.resend.com/emails";

interface EmailResult {
  workspaceId: string;
  workspaceName: string;
  status: "sent" | "skipped" | "failed";
  recipient?: string;
  pendingCount?: number;
  reason?: string;
  // Phase 4.7: parallel Discord transport. One entry per integration row.
  // Email + Discord are independent; either failing does not affect the
  // other. Absent (undefined) for workspaces with no Discord integration.
  discord?: DispatchResult[];
  // Phase 6.9: neglected-themes notice (separate Discord embed +
  // surfaced on the email template). Present only when the workspace has
  // at least one theme flagged; absent otherwise so the report shows
  // the suppression cleanly.
  neglectedThemesDiscord?: NeglectedNoticeResult[];
  neglectedThemesCount?: number;
}

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

  const env = serverEnv();
  // Email + Discord transports are independent. We only short-circuit when
  // BOTH are missing — a workspace with only Discord configured should still
  // get its digest. EMAIL_LINK_SECRET is the cross-transport requirement
  // (it signs both email magic links and Discord button custom_ids).
  const emailEnabled = Boolean(env.RESEND_API_KEY && env.EMAIL_LINK_SECRET);
  const discordEnabled = Boolean(env.DISCORD_BOT_TOKEN && env.EMAIL_LINK_SECRET);
  if (!emailEnabled && !discordEnabled) {
    return NextResponse.json({
      skipped:
        "no transport configured (need RESEND_API_KEY+EMAIL_LINK_SECRET or DISCORD_BOT_TOKEN+EMAIL_LINK_SECRET)",
    });
  }

  const svc = supabaseService();
  const base = siteUrl();
  const linkSecret = env.EMAIL_LINK_SECRET ?? "";

  // 1. Find workspaces with pending_approval posts. We do this in two steps
  //    because Supabase doesn't expose a clean "group by + having count > 0"
  //    over the JS client; pulling minimal columns and dedup'ing in JS is
  //    fine at expected workspace counts (low hundreds).
  const { data: pendingRows, error: pendErr } = await svc
    .from("posts")
    .select("workspace_id")
    .eq("status", "pending_approval");
  if (pendErr) {
    return NextResponse.json({ error: pendErr.message }, { status: 500 });
  }

  const workspaceIds = Array.from(new Set((pendingRows ?? []).map((r) => r.workspace_id)));
  if (workspaceIds.length === 0) {
    return NextResponse.json({ checked: 0, sent: 0, results: [] });
  }

  const { data: workspaces, error: wsErr } = await svc
    .from("workspaces")
    .select("id, name, owner_id")
    .in("id", workspaceIds);
  if (wsErr) {
    return NextResponse.json({ error: wsErr.message }, { status: 500 });
  }

  const results: EmailResult[] = [];
  let sentCount = 0;

  for (const ws of workspaces ?? []) {
    const result: EmailResult = {
      workspaceId: ws.id,
      workspaceName: ws.name,
      status: "skipped",
    };

    // Pull the pending posts FIRST — we use them for both transports.
    // Order: oldest first so the most urgent ones lead the digest.
    const { data: posts, error: postsErr } = await svc
      .from("posts")
      .select("id, channel, theme, text, scheduled_at, created_at")
      .eq("workspace_id", ws.id)
      .eq("status", "pending_approval")
      .order("created_at", { ascending: true })
      .limit(MAX_POSTS_PER_EMAIL + 50); // pull a little extra to count overflow
    if (postsErr) {
      result.status = "failed";
      result.reason = postsErr.message;
      results.push(result);
      continue;
    }

    const totalPending = posts?.length ?? 0;
    result.pendingCount = totalPending;
    if (totalPending === 0) {
      result.status = "skipped";
      result.reason = "no pending posts (race)";
      results.push(result);
      continue;
    }

    const top: DigestPost[] = (posts ?? []).slice(0, MAX_POSTS_PER_EMAIL).map((p) => ({
      id: p.id,
      channel: p.channel,
      theme: p.theme,
      text: p.text,
      scheduledAt: p.scheduled_at,
    }));

    // Phase 6.9 — pull neglected themes for this workspace. Bounded to
    // DIGEST_NEGLECTED_LIMIT entries in the email + Discord transports.
    // findNeglectedThemes short-circuits when theme_gaps_enabled=false,
    // so no extra opt-out plumbing needed here.
    let neglectedThemes: Awaited<ReturnType<typeof findNeglectedThemes>> = [];
    try {
      neglectedThemes = await findNeglectedThemes(ws.id);
    } catch (err) {
      // Detection failure is non-fatal — keep shipping the digest. Capture to Sentry
      // so we know when this breaks. Graceful no-op when SENTRY_DSN is unset.
      Sentry.captureException(err, {
        tags: { cron: "email-digest", workspace_id: ws.id, phase: "neglected-themes" },
      });
      console.warn(`Neglected-theme detection failed for ${ws.id}:`, err);
    }
    result.neglectedThemesCount = neglectedThemes.length;
    const neglectedForDigest = neglectedThemes.slice(0, DIGEST_NEGLECTED_LIMIT);

    // ── Discord transport ──────────────────────────────────────────────
    // Independent of email. dispatchDigest looks up the workspace's
    // Discord integrations and fans out; returns [] when none configured
    // so this is a zero-cost no-op for workspaces without Discord.
    if (discordEnabled) {
      try {
        const discordResults = await dispatchDigest({
          workspaceId: ws.id,
          workspaceName: ws.name,
          posts: top,
          totalPending,
        });
        if (discordResults.length > 0) result.discord = discordResults;
      } catch (err) {
        result.discord = [
          {
            integrationId: "",
            channelId: "",
            status: "failed",
            reason: err instanceof Error ? err.message : "dispatch_failed",
          },
        ];
      }

      // Phase 6.9 — separate neglected-themes embed. Suppressed when no
      // themes are flagged; never fails the digest itself.
      if (neglectedForDigest.length > 0) {
        try {
          const notice = await dispatchNeglectedThemesNotice({
            workspaceId: ws.id,
            workspaceName: ws.name,
            themes: neglectedForDigest,
          });
          if (notice.length > 0) result.neglectedThemesDiscord = notice;
        } catch (err) {
          result.neglectedThemesDiscord = [
            {
              integrationId: "",
              channelId: "",
              status: "failed",
              reason: err instanceof Error ? err.message : "dispatch_failed",
            },
          ];
        }
      }
    }

    // ── Email transport ────────────────────────────────────────────────
    if (!emailEnabled) {
      // No email configured for this run. If Discord succeeded we still
      // mark the workspace as "sent" so the report reflects something
      // shipped; otherwise we'd misleadingly count it as skipped.
      const discordSent = result.discord?.some((d) => d.status === "sent");
      if (discordSent) {
        result.status = "sent";
        sentCount += 1;
      } else {
        result.status = "skipped";
        result.reason = result.reason ?? "email not configured; no Discord delivery";
      }
      results.push(result);
      continue;
    }

    // Look up the owner's email via the admin API. Returns null user if
    // the owner row was deleted; we skip those quietly.
    const { data: userResp, error: userErr } = await svc.auth.admin.getUserById(ws.owner_id);
    if (userErr || !userResp?.user?.email) {
      // Email lookup failed — but Discord may still have delivered. Treat
      // as a soft skip and credit any successful Discord delivery.
      const discordSent = result.discord?.some((d) => d.status === "sent");
      result.status = discordSent ? "sent" : "skipped";
      result.reason = userErr?.message ?? "owner has no email";
      if (discordSent) sentCount += 1;
      results.push(result);
      continue;
    }
    const recipient = userResp.user.email;
    result.recipient = recipient;

    const html = renderDigestEmail({
      workspaceName: ws.name,
      posts: top,
      totalPending,
      approveLinkFor: (postId) =>
        `${base}/api/approve?token=${encodeURIComponent(
          signLinkToken({ postId, action: "approve" }, linkSecret),
        )}`,
      rejectLinkFor: (postId) =>
        `${base}/api/reject?token=${encodeURIComponent(
          signLinkToken({ postId, action: "reject" }, linkSecret),
        )}`,
      queueUrl: `${base}/queue`,
      dashboardUrl: `${base}/dashboard`,
      neglectedThemes: neglectedForDigest.map((t) => ({
        theme: t.theme,
        engagement_rate_30d: t.engagement_rate_30d,
        days_since_last_post: t.days_since_last_post,
      })),
    });

    const subject =
      totalPending === 1
        ? `1 post awaiting approval — ${ws.name}`
        : `${totalPending} posts awaiting approval — ${ws.name}`;

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
          subject,
          html,
        }),
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        result.status = "failed";
        result.reason = `resend ${resp.status}: ${errText.slice(0, 300)}`;
      } else {
        result.status = "sent";
        sentCount += 1;
      }
    } catch (err) {
      // Capture the error to Sentry so silently-broken crons are visible. Graceful
      // no-op when SENTRY_DSN is unset.
      Sentry.captureException(err, {
        tags: { cron: "email-digest", workspace_id: ws.id, phase: "send" },
      });
      result.status = "failed";
      result.reason = err instanceof Error ? err.message : "fetch failed";
    }

    results.push(result);
  }

  return NextResponse.json({
    checked: workspaces?.length ?? 0,
    sent: sentCount,
    results,
    at: new Date().toISOString(),
  });
}

function authorized(req: NextRequest): boolean {
  const env = serverEnv();
  const header = req.headers.get("authorization") ?? "";
  if (header === `Bearer ${env.CRON_SECRET}`) return true;
  const qs = req.nextUrl.searchParams.get("secret");
  return qs === env.CRON_SECRET;
}
