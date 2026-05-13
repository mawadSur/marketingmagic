import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { QueueRow, type QueueMediaItem } from "./queue-row";

export const dynamic = "force-dynamic";

interface PostQueryRow {
  id: string;
  text: string;
  theme: string | null;
  scheduled_at: string | null;
  status: string;
  channel: string;
  media: unknown;
  generation_metadata: unknown;
}

export default async function QueuePage() {
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();
  const { data: posts } = await supabase
    .from("posts")
    .select("id, text, theme, scheduled_at, status, channel, social_account_id, media, generation_metadata")
    .eq("workspace_id", ws.id)
    .in("status", ["pending_approval", "scheduled"])
    .order("scheduled_at", { ascending: true });

  const rows = ((posts ?? []) as PostQueryRow[]).map((p) => {
    const media = Array.isArray(p.media) ? (p.media as QueueMediaItem[]) : [];
    const meta = (p.generation_metadata ?? {}) as { image_prompt?: string | null };
    return {
      id: p.id,
      text: p.text,
      theme: p.theme,
      scheduled_at: p.scheduled_at,
      status: p.status,
      channel: p.channel,
      media,
      image_prompt: meta.image_prompt ?? null,
      mediaPublicUrl: media[0]?.storage_path
        ? publicUrlFor(media[0].storage_path)
        : null,
    };
  });

  const pending = rows.filter((p) => p.status === "pending_approval");
  const scheduled = rows.filter((p) => p.status === "scheduled");

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

function publicUrlFor(storagePath: string): string {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "") ?? "";
  return `${base}/storage/v1/object/public/post-media/${storagePath}`;
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
