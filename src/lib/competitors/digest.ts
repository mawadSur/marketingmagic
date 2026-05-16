// Phase 6.6 — Weekly competitor pattern digest.
//
// One-shot dispatcher that, for a single workspace, formats the top
// winners from the trailing 7 days into:
//   1. An email body (HTML) sent via Resend, when configured.
//   2. A Discord embed sent to every digest-enabled integration row.
//
// Reuses Phase 4.7 transports without modifying them. Suppresses entirely
// when there are no winners in the window — silence is the right default.

import { supabaseService } from "@/lib/supabase/service";
import { sendMessage, DiscordApiError } from "@/lib/integrations/discord";
import { siteUrl, serverEnv } from "@/lib/env";
import type { DiscordEventFilters, Database, CompetitorWatchChannel } from "@/lib/db/types";

const DIGEST_LOOKBACK_DAYS = 7;
const MAX_WINNERS_PER_DIGEST = 6;

type CompetitorPostRow = Database["public"]["Tables"]["competitor_posts"]["Row"];
type WatchHandleRow = Database["public"]["Tables"]["watch_handles"]["Row"];

export interface CompetitorDigestResult {
  workspaceId: string;
  status: "sent" | "skipped" | "failed";
  winnersIncluded: number;
  emailRecipient?: string;
  emailStatus?: "sent" | "skipped" | "failed";
  emailReason?: string;
  discord?: Array<{ integrationId: string; channelId: string; status: "sent" | "skipped" | "failed"; reason?: string }>;
}

export async function buildAndDispatchWeeklyDigest(
  workspaceId: string,
  workspaceName: string,
  ownerEmail: string | null,
): Promise<CompetitorDigestResult> {
  const svc = supabaseService();
  const since = new Date(
    Date.now() - DIGEST_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data: winners } = await svc
    .from("competitor_posts")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("is_winner", true)
    .gte("posted_at", since)
    .order("engagement_rate", { ascending: false, nullsFirst: false })
    .limit(MAX_WINNERS_PER_DIGEST);

  const winnerRows = (winners ?? []) as CompetitorPostRow[];
  if (winnerRows.length === 0) {
    return { workspaceId, status: "skipped", winnersIncluded: 0 };
  }

  // Resolve handle metadata in one query (no relation join — keeps types narrow).
  const handleIds = Array.from(new Set(winnerRows.map((w) => w.watch_handle_id)));
  const { data: handles } = await svc
    .from("watch_handles")
    .select("id, channel, handle, display_name")
    .in("id", handleIds);
  const handleById = new Map<string, WatchHandleRow>();
  for (const h of handles ?? []) {
    handleById.set(h.id, h as WatchHandleRow);
  }

  const result: CompetitorDigestResult = {
    workspaceId,
    status: "skipped",
    winnersIncluded: winnerRows.length,
    discord: [],
  };
  const env = serverEnv();
  const base = siteUrl();
  const dashboardUrl = `${base}/competitors`;

  // ── Discord transport ──────────────────────────────────────────────
  if (env.DISCORD_BOT_TOKEN) {
    const { data: integrations } = await svc
      .from("integrations")
      .select("id, target_channel_id, event_filters")
      .eq("workspace_id", workspaceId)
      .eq("provider", "discord");
    for (const integration of integrations ?? []) {
      const filters = parseFilters(integration.event_filters);
      if (!filters.digest) {
        result.discord!.push({
          integrationId: integration.id,
          channelId: integration.target_channel_id,
          status: "skipped",
          reason: "digest disabled",
        });
        continue;
      }
      if (integration.target_channel_id.startsWith("__pending__:")) {
        result.discord!.push({
          integrationId: integration.id,
          channelId: integration.target_channel_id,
          status: "skipped",
          reason: "channel not configured",
        });
        continue;
      }
      try {
        await sendMessage(
          integration.target_channel_id,
          buildDiscordEmbed(workspaceName, winnerRows, handleById, dashboardUrl),
        );
        result.discord!.push({
          integrationId: integration.id,
          channelId: integration.target_channel_id,
          status: "sent",
        });
        result.status = "sent";
      } catch (err) {
        result.discord!.push({
          integrationId: integration.id,
          channelId: integration.target_channel_id,
          status: "failed",
          reason:
            err instanceof DiscordApiError
              ? `${err.message}${err.bodyExcerpt ? ` — ${err.bodyExcerpt}` : ""}`
              : err instanceof Error
                ? err.message
                : "unknown",
        });
      }
    }
  }

  // ── Email transport ────────────────────────────────────────────────
  if (env.RESEND_API_KEY && ownerEmail) {
    result.emailRecipient = ownerEmail;
    try {
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: env.EMAIL_FROM,
          to: ownerEmail,
          subject: `Competitor winners this week — ${workspaceName}`,
          html: buildEmailHtml(workspaceName, winnerRows, handleById, dashboardUrl),
        }),
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        result.emailStatus = "failed";
        result.emailReason = `resend ${resp.status}: ${errText.slice(0, 200)}`;
      } else {
        result.emailStatus = "sent";
        result.status = "sent";
      }
    } catch (err) {
      result.emailStatus = "failed";
      result.emailReason = err instanceof Error ? err.message : "fetch failed";
    }
  } else {
    result.emailStatus = "skipped";
    result.emailReason = ownerEmail ? "no_resend_key" : "no_owner_email";
  }

  return result;
}

function buildDiscordEmbed(
  workspaceName: string,
  winners: CompetitorPostRow[],
  handles: Map<string, WatchHandleRow>,
  dashboardUrl: string,
) {
  const lines = winners.slice(0, MAX_WINNERS_PER_DIGEST).map((w) => {
    const h = handles.get(w.watch_handle_id);
    const handleLabel = h ? `@${h.handle}` : "unknown";
    const channel = h ? channelLabel(h.channel as CompetitorWatchChannel) : "—";
    const tags = (w.pattern_tags ?? []).slice(0, 3).join(", ") || "—";
    const snippet = truncate(w.text.replace(/\s+/g, " "), 140);
    return `• **${channel} ${handleLabel}** — _${tags}_\n  ${snippet}`;
  });
  return {
    embeds: [
      {
        title: `${winners.length} competitor winner${winners.length === 1 ? "" : "s"} this week`,
        description:
          "Pattern-tagged top performers from your watch list. Read-only — never adversarial.\n\n" +
          lines.join("\n\n"),
        color: 0x6366f1, // indigo — distinct from the digest blue and neglected amber
        footer: { text: `marketingmagic · ${workspaceName}` },
        timestamp: new Date().toISOString(),
      },
    ],
    components: [
      {
        type: 1 as const,
        components: [
          {
            type: 2 as const,
            style: 5 as const,
            label: "Open Competitors",
            url: dashboardUrl,
          },
        ],
      },
    ],
  };
}

function buildEmailHtml(
  workspaceName: string,
  winners: CompetitorPostRow[],
  handles: Map<string, WatchHandleRow>,
  dashboardUrl: string,
): string {
  const rows = winners.map((w) => {
    const h = handles.get(w.watch_handle_id);
    const handleLabel = h ? `@${h.handle}` : "unknown";
    const channel = h ? channelLabel(h.channel as CompetitorWatchChannel) : "—";
    const tags = (w.pattern_tags ?? []).slice(0, 3).map((t) => `<code style="background:#f1f5f9;padding:2px 6px;border-radius:4px;font-size:12px;">${esc(t)}</code>`).join(" ") || "—";
    const reason = w.pattern_reason ? `<p style="margin:4px 0 0;color:#64748b;font-size:13px;font-style:italic;">Possible reason: ${esc(w.pattern_reason)}</p>` : "";
    const link = w.post_url ? `<a href="${esc(w.post_url)}" style="color:#2563eb;font-size:12px;">Source ↗</a>` : "";
    return `
      <tr><td style="padding:16px;border-bottom:1px solid #e2e8f0;">
        <p style="margin:0;font-size:13px;color:#64748b;">
          <strong style="color:#0f172a;">${esc(channel)} ${esc(handleLabel)}</strong> · ${tags} ${link}
        </p>
        <p style="margin:8px 0 0;font-size:14px;line-height:1.5;color:#0f172a;">${esc(truncate(w.text.replace(/\s+/g, " "), 280))}</p>
        ${reason}
      </td></tr>`;
  });

  return `
<!doctype html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f8fafc;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="background:#ffffff;border-radius:8px;overflow:hidden;">
        <tr><td style="padding:24px 24px 0;">
          <p style="margin:0;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;">Competitor Watch · weekly</p>
          <h1 style="margin:8px 0 4px;font-size:22px;color:#0f172a;">${winners.length} winner${winners.length === 1 ? "" : "s"} this week</h1>
          <p style="margin:0;color:#475569;font-size:14px;">${esc(workspaceName)} — pattern-tagged top performers from your watch list. Read-only.</p>
        </td></tr>
        <tr><td>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            ${rows.join("")}
          </table>
        </td></tr>
        <tr><td style="padding:16px 24px 24px;">
          <a href="${esc(dashboardUrl)}" style="display:inline-block;background:#0f172a;color:#ffffff;padding:10px 16px;border-radius:6px;font-size:14px;text-decoration:none;">Open Competitors →</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function parseFilters(raw: unknown): DiscordEventFilters {
  if (!raw || typeof raw !== "object") {
    return { digest: true, realtime: false, alerts_only: false };
  }
  const r = raw as Partial<DiscordEventFilters>;
  return {
    digest: r.digest !== false,
    realtime: r.realtime === true,
    alerts_only: r.alerts_only === true,
  };
}

function channelLabel(c: CompetitorWatchChannel): string {
  switch (c) {
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

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
