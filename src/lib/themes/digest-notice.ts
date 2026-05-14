// Phase 6.9 — Neglected-themes notice for the daily digest transports.
//
// Owned by the themes module so we stay out of src/lib/integrations/* (Discord
// transport is owned by another sub-agent). Imports the public sendMessage
// helper from the Discord wrapper but does NOT modify it.
//
// For each workspace passed in, fans out a single short embed to every
// Discord integration with digest=true. Suppresses entirely when there are
// no neglected themes — the goal is "no gaps → no message at all".

import { supabaseService } from "@/lib/supabase/service";
import { sendMessage, DiscordApiError } from "@/lib/integrations/discord";
import { siteUrl, serverEnv } from "@/lib/env";
import type { DiscordEventFilters } from "@/lib/db/types";
import type { NeglectedTheme } from "@/lib/themes/gaps";

export interface DispatchNeglectedNoticeOpts {
  workspaceId: string;
  workspaceName: string;
  themes: NeglectedTheme[];
}

export interface NeglectedNoticeResult {
  integrationId: string;
  channelId: string;
  status: "sent" | "skipped" | "failed";
  reason?: string;
}

// Single source of truth for "how many themes to surface in transport
// notices" — keep aligned with email and Discord behaviour.
export const DIGEST_NEGLECTED_LIMIT = 2;

export async function dispatchNeglectedThemesNotice(
  opts: DispatchNeglectedNoticeOpts,
): Promise<NeglectedNoticeResult[]> {
  if (opts.themes.length === 0) return [];

  const env = serverEnv();
  if (!env.DISCORD_BOT_TOKEN) return [];

  const svc = supabaseService();
  const { data: rows } = await svc
    .from("integrations")
    .select("id, target_channel_id, event_filters")
    .eq("workspace_id", opts.workspaceId)
    .eq("provider", "discord");
  const integrations = rows ?? [];
  if (integrations.length === 0) return [];

  const limited = opts.themes.slice(0, DIGEST_NEGLECTED_LIMIT);
  const dashboardUrl = `${siteUrl()}/dashboard`;
  const results: NeglectedNoticeResult[] = [];

  for (const row of integrations) {
    const result: NeglectedNoticeResult = {
      integrationId: row.id,
      channelId: row.target_channel_id,
      status: "skipped",
    };
    const filters = parseFilters(row.event_filters);
    if (!filters.digest) {
      result.reason = "digest disabled";
      results.push(result);
      continue;
    }
    if (row.target_channel_id.startsWith("__pending__:")) {
      result.reason = "channel not configured";
      results.push(result);
      continue;
    }
    try {
      await sendMessage(row.target_channel_id, buildEmbed(opts.workspaceName, limited, dashboardUrl));
      result.status = "sent";
    } catch (err) {
      result.status = "failed";
      result.reason =
        err instanceof DiscordApiError
          ? `${err.message}${err.bodyExcerpt ? ` — ${err.bodyExcerpt}` : ""}`
          : err instanceof Error
            ? err.message
            : "unknown_error";
    }
    results.push(result);
  }

  return results;
}

function buildEmbed(workspaceName: string, themes: NeglectedTheme[], dashboardUrl: string) {
  const lines = themes.map((t) => {
    const rate = (t.engagement_rate_30d * 100).toFixed(2);
    return `• **#${truncate(t.theme, 40)}** — ${rate}% engagement · last posted ${t.days_since_last_post}d ago`;
  });
  return {
    embeds: [
      {
        title: themes.length === 1 ? "1 neglected theme" : `${themes.length} neglected themes`,
        description:
          "Top-quartile themes that have gone quiet. Regenerate from the dashboard to keep the calendar balanced.\n\n" +
          lines.join("\n"),
        color: 0xf59e0b, // amber — distinct from the blue digest color
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
            label: "Open dashboard",
            url: dashboardUrl,
          },
        ],
      },
    ],
  };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
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
