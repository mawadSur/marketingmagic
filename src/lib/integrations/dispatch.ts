// Cross-integration digest dispatcher. Called by the email-digest cron in
// parallel with the email transport so a single workspace can fan out to
// both. Failures inside one transport never break the other — every
// integration row is wrapped in its own try/catch and surfaced as a
// per-row result so the cron route can return a structured report.
//
// We deliberately read integrations via the service client (RLS would
// block service-role; cron has no user context). Authorization to call
// this function is the caller's responsibility — the email-digest cron
// already gates on Bearer CRON_SECRET.

import { supabaseService } from "@/lib/supabase/service";
import { sendMessage, startThread, DiscordApiError } from "@/lib/integrations/discord";
import { buildDigestMessage, buildPostEmbed, type DigestPostSummary } from "@/lib/integrations/embeds";
import { siteUrl, serverEnv } from "@/lib/env";
import type { DiscordEventFilters } from "@/lib/db/types";

export interface DispatchPostInput {
  id: string;
  channel: string;
  theme: string | null;
  text: string;
  scheduledAt: string | null;
}

export interface DispatchResult {
  integrationId: string;
  channelId: string;
  status: "sent" | "skipped" | "failed";
  reason?: string;
}

export interface DispatchOptions {
  workspaceId: string;
  workspaceName: string;
  posts: DispatchPostInput[];
  totalPending: number;
}

/**
 * Fan out a daily digest to every Discord integration on the workspace
 * where the digest filter is enabled. Returns one result per integration
 * row, never throws.
 *
 * Threading discipline: one parent digest embed → if there are pending
 * posts, we spawn a thread off the parent and post each per-post embed
 * with approve/reject buttons inside the thread. The channel stays quiet;
 * the conversation lives in the thread.
 */
export async function dispatchDigest(opts: DispatchOptions): Promise<DispatchResult[]> {
  const env = serverEnv();
  // Without a bot token we cannot send anything. EMAIL_LINK_SECRET is
  // required because per-post embeds carry signed approval buttons.
  if (!env.DISCORD_BOT_TOKEN || !env.EMAIL_LINK_SECRET) return [];

  const svc = supabaseService();
  const { data: rows } = await svc
    .from("integrations")
    .select("id, target_channel_id, event_filters")
    .eq("workspace_id", opts.workspaceId)
    .eq("provider", "discord");

  const integrations = rows ?? [];
  if (integrations.length === 0) return [];

  const results: DispatchResult[] = [];
  const linkSecret = env.EMAIL_LINK_SECRET;
  const queueUrl = `${siteUrl()}/queue`;

  for (const row of integrations) {
    const result: DispatchResult = {
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
      const parent = await sendMessage(
        row.target_channel_id,
        buildDigestMessage({
          workspaceName: opts.workspaceName,
          posts: opts.posts.map(toSummary),
          totalPending: opts.totalPending,
          queueUrl,
        }),
      );

      // Thread out the per-post embeds when there are posts to drill into.
      // If the thread spawn or any per-post send fails we still count the
      // parent as sent — the digest itself reached the channel.
      if (opts.posts.length > 0) {
        try {
          const threadName = `Pending approvals · ${new Date().toUTCString().slice(5, 16)}`;
          const thread = await startThread(row.target_channel_id, parent.id, threadName);
          for (const p of opts.posts) {
            const payload = buildPostEmbed({
              post: toSummary(p),
              workspaceName: opts.workspaceName,
              linkSecret,
            });
            try {
              await sendMessage(thread.id, payload);
            } catch {
              // Per-post failure is non-fatal — keep going.
            }
          }
        } catch {
          // Thread spawn failed; the parent is up, that's good enough.
        }
      }

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

function toSummary(p: DispatchPostInput): DigestPostSummary {
  return {
    id: p.id,
    channel: p.channel,
    theme: p.theme,
    text: p.text,
    scheduledAt: p.scheduledAt,
  };
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
