import Link from "next/link";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { ChannelBadge, statusBadgeVariant, Badge, statusBadgeLabel } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";

export const dynamic = "force-dynamic";

const CONNECTORS = [
  { slug: "x", label: "Connect X" },
  { slug: "linkedin", label: "Connect LinkedIn" },
  { slug: "threads", label: "Connect Threads" },
  { slug: "instagram", label: "Connect Instagram" },
  { slug: "bluesky", label: "Connect Bluesky" },
] as const;

export default async function ChannelsPage() {
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();
  const { data: accounts } = await supabase
    .from("social_accounts_safe")
    .select("*")
    .eq("workspace_id", ws.id)
    .order("created_at", { ascending: true });

  const hasAny = accounts && accounts.length > 0;

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header className="space-y-1">
        <p className="label-eyebrow">Settings</p>
        <h1 className="text-3xl font-semibold tracking-tight">Channels</h1>
        <p className="text-sm text-muted-foreground">
          Connected social accounts. Credentials live server-side only — never exposed to the browser.
        </p>
      </header>

      <section className="space-y-3">
        <div className="flex items-end justify-between">
          <h2 className="text-base font-medium">Connected</h2>
          {hasAny ? (
            <span className="text-xs text-muted-foreground tabular-nums">
              {accounts!.length} {accounts!.length === 1 ? "account" : "accounts"}
            </span>
          ) : null}
        </div>
        {hasAny ? (
          <ul className="divide-y rounded-lg border bg-card">
            {accounts!.map((a) => (
              <li key={a.id} className="transition-colors duration-200 hover:bg-muted/30">
                <Link
                  href={`/settings/channels/${a.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2.5">
                    <ChannelBadge channel={a.channel} />
                    <span className="font-medium">@{a.handle}</span>
                    <span className="text-xs text-muted-foreground">
                      {a.trust_mode
                        ? `auto-post (${a.successful_post_count}/${a.trust_threshold})`
                        : "manual approval"}
                    </span>
                  </div>
                  <Badge variant={statusBadgeVariant(a.status)}>
                    {statusBadgeLabel(a.status)}
                  </Badge>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon="plug"
            title="No channels connected yet."
            description="Pick a network below — credentials are stored encrypted, server-side only."
          />
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-medium">Add a channel</h2>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {CONNECTORS.map((c) => (
            <Link
              key={c.slug}
              href={`/settings/channels/${c.slug}`}
              className="card-hover flex items-center gap-3 rounded-md border bg-card px-3 py-2.5 text-sm font-medium"
            >
              <ChannelBadge channel={c.slug} />
              <span>{c.label}</span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
