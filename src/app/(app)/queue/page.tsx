import Link from "next/link";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { EmptyState } from "@/components/ui/empty-state";
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
    <div className="space-y-10">
      <header className="space-y-1">
        <p className="label-eyebrow">Drafts &amp; schedule</p>
        <h1 className="text-3xl font-semibold tracking-tight">Approval queue</h1>
        <p className="text-sm text-muted-foreground">
          Approve, edit, or reject. Approved drafts go straight to the schedule — you keep the kill switch.
        </p>
      </header>

      <Section
        title="Pending approval"
        count={pending.length}
        empty={
          <EmptyState
            icon="inbox"
            title="Inbox zero."
            description="Generate a plan to seed the queue with drafts, or send a webhook event to auto-fill it."
            action={
              <Link
                href="/plans/new"
                className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity duration-200 hover:opacity-90"
              >
                Generate plan
              </Link>
            }
          />
        }
      >
        {pending.map((p) => (
          <QueueRow key={p.id} post={p} />
        ))}
      </Section>

      <Section
        title="Scheduled"
        count={scheduled.length}
        empty={
          <EmptyState
            icon="calendar"
            title="Nothing on the schedule."
            description="Approve a draft above and it'll line up here — revoke any time before it goes live."
          />
        }
      >
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
  empty: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 text-base font-medium">
        {title}
        <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-md border bg-muted/40 px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground">
          {count}
        </span>
      </h2>
      {count === 0 ? empty : <ul className="divide-y rounded-lg border bg-card">{children}</ul>}
    </section>
  );
}
