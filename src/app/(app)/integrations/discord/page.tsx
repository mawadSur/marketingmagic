import Link from "next/link";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { serverEnv, siteUrl } from "@/lib/env";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { DiscordInstallButton } from "@/components/discord-install-button";
import type { DiscordEventFilters } from "@/lib/db/types";
import {
  updateChannelAction,
  updateFiltersAction,
  sendTestMessageAction,
  removeIntegrationAction,
} from "./actions";

// /integrations/discord. Three states:
//   1. Env not configured → "configure to enable" empty state.
//   2. Env configured but no integrations rows → "install bot" CTA.
//   3. Installed → per-row config: channel id, filter toggles, test send,
//      remove. Multiple rows allowed (multi-channel routing).

export const dynamic = "force-dynamic";

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

export default async function DiscordIntegrationPage({
  searchParams,
}: {
  searchParams: Promise<{ installed?: string; guild?: string; error?: string; saved?: string }>;
}) {
  const { installed, guild, error, saved } = await searchParams;

  const ws = await getActiveWorkspaceOrRedirect();
  const env = serverEnv();
  const supabase = await supabaseServer();

  const configured = Boolean(
    env.DISCORD_CLIENT_ID && env.DISCORD_PUBLIC_KEY && env.DISCORD_BOT_TOKEN,
  );

  const { data: rows } = await supabase
    .from("integrations")
    .select("*")
    .eq("workspace_id", ws.id)
    .eq("provider", "discord")
    .order("installed_at", { ascending: false });

  const integrations = rows ?? [];

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="space-y-1">
        <p className="label-eyebrow">
          <Link href="/integrations" className="hover:underline">
            Integrations
          </Link>
          {" · "}Discord
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Discord</h1>
        <p className="text-sm text-muted-foreground">
          Daily digest, per-post approval buttons, and{" "}
          <code>/mm queue · /mm stats · /mm pause</code> slash commands. Bot installs to one of
          your Discord servers; you pick the destination channel below.
        </p>
      </header>

      {installed ? (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-4 text-sm">
          <p className="font-medium">
            Bot installed{guild ? ` to ${decodeURIComponent(guild)}` : ""}.
          </p>
          <p className="mt-1 text-muted-foreground">
            Set the destination channel below to start receiving digests.
          </p>
        </div>
      ) : null}
      {saved ? (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm">
          {saved === "channel" ? "Channel saved." : null}
          {saved === "filters" ? "Filters saved." : null}
          {saved === "test_sent" ? "Test message sent — check the channel." : null}
          {saved === "removed" ? "Integration removed." : null}
        </div>
      ) : null}
      {error ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm">
          <p className="font-medium text-destructive">Action failed.</p>
          <p className="mt-1 text-muted-foreground">{decodeURIComponent(error)}</p>
        </div>
      ) : null}

      {!configured ? (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/5 p-4 text-sm">
          <p className="font-medium">Discord integration is not configured.</p>
          <p className="mt-1 text-muted-foreground">
            Set <code>DISCORD_CLIENT_ID</code>, <code>DISCORD_CLIENT_SECRET</code>,{" "}
            <code>DISCORD_PUBLIC_KEY</code>, and <code>DISCORD_BOT_TOKEN</code> in your
            environment, then restart. Create an application at{" "}
            <a
              className="underline-offset-4 hover:underline"
              href="https://discord.com/developers/applications"
              target="_blank"
              rel="noreferrer"
            >
              discord.com/developers/applications
            </a>{" "}
            and set the interactions endpoint to{" "}
            <code>{siteUrl()}/api/integrations/discord/action</code>.
          </p>
        </div>
      ) : integrations.length === 0 ? (
        <div className="space-y-4">
          <EmptyState
            icon="plug"
            title="Bot not installed yet."
            description="Install the bot to a Discord server you own. The OAuth flow asks you which server; you'll set the destination channel here afterwards."
            action={<DiscordInstallButton />}
          />
        </div>
      ) : (
        <div className="space-y-6">
          {integrations.map((row) => {
            const filters = parseFilters(row.event_filters);
            const isPending = row.target_channel_id.startsWith("__pending__:");
            return (
              <section
                key={row.id}
                className="space-y-4 rounded-lg border bg-card p-5"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">
                      {row.target_guild_id ? (
                        <>
                          Guild{" "}
                          <span className="font-mono text-xs">
                            {row.target_guild_id}
                          </span>
                        </>
                      ) : (
                        "Unknown guild"
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Installed{" "}
                      {new Date(row.installed_at).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}
                    </p>
                  </div>
                  {isPending ? (
                    <Badge variant="warning">channel not set</Badge>
                  ) : (
                    <Badge variant="success">active</Badge>
                  )}
                </div>

                {/* Channel selection */}
                <form action={updateChannelAction} className="space-y-2">
                  <input type="hidden" name="integration_id" value={row.id} />
                  <label
                    htmlFor={`channel-${row.id}`}
                    className="block text-xs font-medium text-muted-foreground"
                  >
                    Target channel ID
                  </label>
                  <div className="flex gap-2">
                    <input
                      id={`channel-${row.id}`}
                      type="text"
                      name="target_channel_id"
                      defaultValue={isPending ? "" : row.target_channel_id}
                      placeholder="123456789012345678"
                      className="flex-1 rounded-md border bg-background px-3 py-2 text-sm"
                      pattern="\d{6,32}"
                      required
                    />
                    <Button type="submit" size="sm">
                      Save
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    In Discord: right-click the channel → Copy Channel ID (you may need to
                    enable Developer Mode in your User Settings → Advanced).
                  </p>
                </form>

                {/* Event filters */}
                <form action={updateFiltersAction} className="space-y-2">
                  <input type="hidden" name="integration_id" value={row.id} />
                  <p className="block text-xs font-medium text-muted-foreground">
                    Events
                  </p>
                  <div className="space-y-2">
                    <label className="flex items-start gap-3 text-sm">
                      <input
                        type="checkbox"
                        name="digest"
                        defaultChecked={filters.digest}
                        className="mt-0.5"
                      />
                      <span>
                        <span className="font-medium">Daily digest</span>
                        <span className="block text-xs text-muted-foreground">
                          One summary message per day with approve/reject buttons.
                        </span>
                      </span>
                    </label>
                    <label className="flex items-start gap-3 text-sm">
                      <input
                        type="checkbox"
                        name="realtime"
                        defaultChecked={filters.realtime}
                        className="mt-0.5"
                      />
                      <span>
                        <span className="font-medium">Realtime</span>
                        <span className="block text-xs text-muted-foreground">
                          Send a message every time a post enters pending approval.
                        </span>
                      </span>
                    </label>
                    <label className="flex items-start gap-3 text-sm">
                      <input
                        type="checkbox"
                        name="alerts_only"
                        defaultChecked={filters.alerts_only}
                        className="mt-0.5"
                      />
                      <span>
                        <span className="font-medium">Alerts only</span>
                        <span className="block text-xs text-muted-foreground">
                          High-priority alerts (failed posts, billing).{" "}
                          <em>Reserved; not wired yet.</em>
                        </span>
                      </span>
                    </label>
                  </div>
                  <div className="pt-1">
                    <Button type="submit" size="sm" variant="outline">
                      Save events
                    </Button>
                  </div>
                </form>

                {/* Test message + remove */}
                <div className="flex flex-wrap items-center gap-2 border-t pt-3">
                  <form action={sendTestMessageAction}>
                    <input type="hidden" name="integration_id" value={row.id} />
                    <Button type="submit" size="sm" variant="outline" disabled={isPending}>
                      Send test message
                    </Button>
                  </form>
                  <form action={removeIntegrationAction}>
                    <input type="hidden" name="integration_id" value={row.id} />
                    <Button type="submit" size="sm" variant="ghost">
                      Remove
                    </Button>
                  </form>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {isPending ? "Set channel before testing." : null}
                  </span>
                </div>
              </section>
            );
          })}

          <div className="flex justify-end">
            <DiscordInstallButton label="Install to another server" />
          </div>
        </div>
      )}

      <div className="rounded-md border bg-card p-4 text-xs text-muted-foreground">
        <p className="font-medium text-foreground">After install</p>
        <p className="mt-1">
          Slash commands register globally; first-time setup requires a one-shot{" "}
          <code>POST {siteUrl()}/api/integrations/discord/commands</code> with{" "}
          <code>Bearer CRON_SECRET</code>. Discord may take up to an hour to propagate.
        </p>
      </div>
    </div>
  );
}
