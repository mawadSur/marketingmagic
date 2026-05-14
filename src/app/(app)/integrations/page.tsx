import Link from "next/link";
import { serverEnv } from "@/lib/env";
import { supabaseServer } from "@/lib/supabase/server";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";

// Integrations index. Today only Discord; the page is built to scale to
// Slack/etc. without rework — the "providers" array is the registry.

export const dynamic = "force-dynamic";

interface ProviderRow {
  slug: "discord";
  label: string;
  href: string;
  description: string;
  status: "available" | "not_configured";
}

export default async function IntegrationsPage() {
  const ws = await getActiveWorkspaceOrRedirect();
  const env = serverEnv();
  const supabase = await supabaseServer();

  const { data: rows } = await supabase
    .from("integrations")
    .select("id, provider, target_channel_id, target_guild_id, event_filters, installed_at")
    .eq("workspace_id", ws.id)
    .order("installed_at", { ascending: false });

  const installed = rows ?? [];
  const discordConfigured = Boolean(env.DISCORD_CLIENT_ID && env.DISCORD_PUBLIC_KEY);

  const providers: ProviderRow[] = [
    {
      slug: "discord",
      label: "Discord",
      href: "/integrations/discord",
      description:
        "Approve posts from a Discord channel. Daily digest, per-post buttons, /mm slash commands.",
      status: discordConfigured ? "available" : "not_configured",
    },
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header className="space-y-1">
        <p className="label-eyebrow">Settings</p>
        <h1 className="text-3xl font-semibold tracking-tight">Integrations</h1>
        <p className="text-sm text-muted-foreground">
          Send daily approval digests and per-post embeds to a channel outside the app — approve,
          edit, or reject without opening the web UI.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-base font-medium">Installed</h2>
        {installed.length === 0 ? (
          <EmptyState
            icon="plug"
            title="No integrations yet."
            description="Pick a destination below — bot auth is workspace-scoped, channel-scoped, and revocable from the same screen."
          />
        ) : (
          <ul className="divide-y rounded-lg border bg-card">
            {installed.map((row) => {
              const isPending = row.target_channel_id.startsWith("__pending__:");
              return (
                <li key={row.id} className="transition-colors duration-200 hover:bg-muted/30">
                  <Link
                    href={`/integrations/${row.provider}`}
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm"
                  >
                    <div className="flex flex-wrap items-center gap-2.5">
                      <Badge variant="info">{row.provider}</Badge>
                      <span className="font-medium">
                        {isPending ? "Awaiting channel" : `#${row.target_channel_id.slice(-6)}`}
                      </span>
                      {row.target_guild_id ? (
                        <span className="text-xs text-muted-foreground">
                          guild {row.target_guild_id.slice(-6)}
                        </span>
                      ) : null}
                    </div>
                    <span className="text-xs text-muted-foreground">manage →</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-medium">Add an integration</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {providers.map((p) => (
            <Link
              key={p.slug}
              href={p.href}
              className="card-hover flex flex-col gap-1 rounded-md border bg-card px-4 py-3 text-sm"
            >
              <div className="flex items-center justify-between">
                <span className="font-medium">{p.label}</span>
                <Badge variant={p.status === "available" ? "success" : "warning"}>
                  {p.status === "available" ? "available" : "needs env"}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">{p.description}</p>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
