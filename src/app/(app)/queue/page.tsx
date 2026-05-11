import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { QueueRow } from "./queue-row";

export const dynamic = "force-dynamic";

export default async function QueuePage() {
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();
  const { data: posts } = await supabase
    .from("posts")
    .select("id, text, theme, scheduled_at, status, channel, social_account_id")
    .eq("workspace_id", ws.id)
    .in("status", ["pending_approval", "scheduled"])
    .order("scheduled_at", { ascending: true });

  const pending = (posts ?? []).filter((p) => p.status === "pending_approval");
  const scheduled = (posts ?? []).filter((p) => p.status === "scheduled");

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Approval queue</h1>
        <p className="text-sm text-muted-foreground">
          Approve, edit, or reject drafts. Approved drafts go straight to the schedule.
        </p>
      </header>

      <Section title="Pending approval" empty="No drafts waiting." count={pending.length}>
        {pending.map((p) => (
          <QueueRow key={p.id} post={p} />
        ))}
      </Section>

      <Section title="Scheduled" empty="No scheduled posts yet." count={scheduled.length}>
        {scheduled.map((p) => (
          <QueueRow key={p.id} post={p} />
        ))}
      </Section>
    </div>
  );
}

function Section({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        {title}
        <span className="rounded-md border px-2 py-0.5 text-xs text-muted-foreground">{count}</span>
      </h2>
      {count === 0 ? (
        <p className="rounded-lg border p-4 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="divide-y rounded-lg border">{children}</ul>
      )}
    </section>
  );
}
