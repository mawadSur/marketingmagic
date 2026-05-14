import Link from "next/link";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { EmptyState } from "@/components/ui/empty-state";
import { QueueIdeaRow, QueueRow, type QueueMediaItem } from "./queue-row";

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
  idea_id: string | null;
}

interface QueueDisplayRow {
  id: string;
  text: string;
  theme: string | null;
  scheduled_at: string | null;
  status: string;
  channel: string;
  media: QueueMediaItem[];
  image_prompt: string | null;
  mediaPublicUrl: string | null;
  idea_id: string | null;
}

export default async function QueuePage() {
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();
  const { data: posts } = await supabase
    .from("posts")
    .select(
      "id, text, theme, scheduled_at, status, channel, social_account_id, media, generation_metadata, idea_id",
    )
    .eq("workspace_id", ws.id)
    .in("status", ["pending_approval", "scheduled"])
    .order("scheduled_at", { ascending: true });

  const rows: QueueDisplayRow[] = ((posts ?? []) as PostQueryRow[]).map((p) => {
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
      idea_id: p.idea_id,
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
        {renderGrouped(pending)}
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
        {renderGrouped(scheduled)}
      </Section>
    </div>
  );
}

/**
 * Group rows by idea_id. Rows with idea_id=null render as standalone
 * QueueRow (legacy / single-channel posts). Rows that share an idea_id
 * render as a single QueueIdeaRow with their variants nested inside.
 *
 * Sort order respects the upstream `order by scheduled_at` — the first
 * variant of each idea anchors the idea's position in the list.
 */
function renderGrouped(rows: QueueDisplayRow[]): React.ReactNode {
  type Group =
    | { kind: "single"; row: QueueDisplayRow; sortKey: string }
    | { kind: "idea"; ideaId: string; variants: QueueDisplayRow[]; sortKey: string };

  const byIdea = new Map<string, QueueDisplayRow[]>();
  const standalone: Array<{ row: QueueDisplayRow; sortKey: string }> = [];

  for (const r of rows) {
    if (r.idea_id) {
      const arr = byIdea.get(r.idea_id) ?? [];
      arr.push(r);
      byIdea.set(r.idea_id, arr);
    } else {
      standalone.push({ row: r, sortKey: sortKeyOf(r) });
    }
  }

  const groups: Group[] = [];
  for (const s of standalone) {
    groups.push({ kind: "single", row: s.row, sortKey: s.sortKey });
  }
  for (const [ideaId, variants] of byIdea.entries()) {
    // Single-variant ideas degrade to a plain row — collapsing the header
    // would just be visual noise when there's nothing to compare against.
    if (variants.length === 1) {
      groups.push({ kind: "single", row: variants[0], sortKey: sortKeyOf(variants[0]) });
      continue;
    }
    const earliest = variants.map(sortKeyOf).sort()[0] ?? "";
    groups.push({ kind: "idea", ideaId, variants, sortKey: earliest });
  }

  groups.sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  return groups.map((g) =>
    g.kind === "idea" ? (
      <QueueIdeaRow key={`idea-${g.ideaId}`} ideaId={g.ideaId} variants={g.variants} />
    ) : (
      <QueueRow key={g.row.id} post={g.row} />
    ),
  );
}

function sortKeyOf(r: QueueDisplayRow): string {
  // Fallback to "z" prefix so rows without a scheduled_at land at the end
  // rather than at the top via empty-string sort.
  return r.scheduled_at ?? `zzz-${r.id}`;
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
