import Link from "next/link";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function ChannelsPage() {
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();
  const { data: accounts } = await supabase
    .from("social_accounts_safe")
    .select("*")
    .eq("workspace_id", ws.id)
    .order("created_at", { ascending: true });

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Channels</h1>
        <p className="text-sm text-muted-foreground">
          Connected social accounts. Credentials are stored server-side only and never exposed to the
          browser.
        </p>
      </header>

      <section className="rounded-lg border">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-medium">Connected</h2>
        </div>
        {accounts && accounts.length > 0 ? (
          <ul className="divide-y">
            {accounts.map((a) => (
              <li key={a.id} className="px-4 py-3 text-sm">
                <Link
                  href={`/settings/channels/${a.id}`}
                  className="flex items-center justify-between hover:opacity-90"
                >
                  <div className="flex items-center gap-3">
                    <span className="rounded-md border px-2 py-0.5 text-xs uppercase tracking-wide">
                      {a.channel}
                    </span>
                    <span className="font-medium">@{a.handle}</span>
                    <span className="text-xs text-muted-foreground">
                      {a.trust_mode
                        ? `auto-post (${a.successful_post_count}/${a.trust_threshold})`
                        : "manual approval"}
                    </span>
                  </div>
                  <span
                    className={
                      a.status === "connected"
                        ? "text-xs text-emerald-600"
                        : "text-xs text-destructive"
                    }
                  >
                    {a.status}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            No channels yet. Connect one below.
          </p>
        )}
      </section>

      <div className="flex gap-3">
        <Link
          href="/settings/channels/x"
          className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent"
        >
          Connect X
        </Link>
      </div>
    </div>
  );
}
