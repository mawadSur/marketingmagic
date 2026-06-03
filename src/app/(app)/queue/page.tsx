import Link from "next/link";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { EmptyState } from "@/components/ui/empty-state";
import { QueueIdeaRow, QueueRow, type QueueMediaItem } from "./queue-row";
import { HashtagSuggestionsServer } from "./hashtag-suggestions-server";
import { ThreadBuilderRow, type ThreadTweetRow } from "@/components/thread-builder-ui";
import { readThreadMeta } from "@/lib/threads/schema";

export const dynamic = "force-dynamic";
// publishNowAction (queue/actions.ts) dispatches inline — image/text publish
// hits a platform API + a short status poll (IG images poll to FINISHED for a
// few seconds). Server Actions inherit this segment's maxDuration, and Vercel's
// default is far below what an IG container poll needs, so a successful publish
// was 503-ing the browser AFTER the post went live. Match the post-scheduled
// cron's 60s ceiling so the inline path returns cleanly. Video posts never run
// inline (publishNowAction defers them to the cron) so 60s is sufficient here.
export const maxDuration = 60;

interface PostQueryRow {
  id: string;
  text: string;
  theme: string | null;
  scheduled_at: string | null;
  status: string;
  channel: string;
  media: unknown;
  generation_metadata: unknown;
  voice_score: number | null;
  low_confidence: boolean | null;
  idea_id: string | null;
  external_id: string | null;
  failure_reason: string | null;
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
  voice_score: number | null;
  low_confidence: boolean;
  idea_id: string | null;
  external_id: string | null;
  failure_reason: string | null;
  generation_metadata: unknown;
  // Phase 6B — set when this row is the parent of an active experiment
  // or is itself a variant inside one. Drives both the badge and the
  // suppression of the "Run Quick Experiment" CTA (no recursion).
  experiment_status: "parent" | "variant" | null;
}

export default async function QueuePage() {
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();
  const { data: posts } = await supabase
    .from("posts")
    .select(
      "id, text, theme, scheduled_at, status, channel, social_account_id, media, generation_metadata, voice_score, low_confidence, idea_id, external_id, failure_reason",
    )
    .eq("workspace_id", ws.id)
    .in("status", ["pending_approval", "scheduled"])
    .order("scheduled_at", { ascending: true });

  // Phase 6.8: when any active row in the workspace belongs to a thread,
  // pull the FULL thread (including already-posted or failed tweets) so
  // the queue UI can surface partial-publish state with a retry CTA.
  // Scoped to idea_ids that already appear in the active set — we don't
  // want fully-historical threads polluting the queue.
  const activeIdeaIds = Array.from(
    new Set(((posts ?? []) as PostQueryRow[]).filter((p) => p.idea_id).map((p) => p.idea_id!)),
  );
  let extraThreadRows: PostQueryRow[] = [];
  if (activeIdeaIds.length > 0) {
    const { data: extras } = await supabase
      .from("posts")
      .select(
        "id, text, theme, scheduled_at, status, channel, social_account_id, media, generation_metadata, voice_score, low_confidence, idea_id, external_id, failure_reason",
      )
      .eq("workspace_id", ws.id)
      .in("idea_id", activeIdeaIds)
      .in("status", ["posted", "failed"])
      .order("scheduled_at", { ascending: true });
    extraThreadRows = (extras ?? []) as PostQueryRow[];
  }

  const allRawRows: PostQueryRow[] = [
    ...((posts ?? []) as PostQueryRow[]),
    ...extraThreadRows,
  ];
  // Dedupe (idea_id pull may overlap with the active query when rows
  // share state in transit). Last write wins — extras are always the
  // posted/failed completion state.
  const seen = new Set<string>();
  const deduped: PostQueryRow[] = [];
  for (const r of allRawRows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    deduped.push(r);
  }

  // Phase 6B — pre-load experiment relationships for every post in the
  // queue, in one pass. We use these to flag rows as parent/variant for
  // the badge + the "Run Quick Experiment" CTA suppression. Best-effort:
  // if either query fails we just render the queue without experiment
  // metadata — no surfaces break.
  const allPostIds = deduped.map((p) => p.id);
  const experimentVariantPostIds = new Set<string>();
  const experimentParentPostIds = new Set<string>();
  if (allPostIds.length > 0) {
    const [variantRes, parentRes] = await Promise.all([
      supabase
        .from("post_variants")
        .select("parent_post_id")
        .in("parent_post_id", allPostIds),
      supabase
        .from("experiments")
        .select("parent_post_id, status")
        .in("parent_post_id", allPostIds)
        .neq("status", "cancelled"),
    ]);
    for (const row of variantRes.data ?? []) {
      if (row.parent_post_id) experimentVariantPostIds.add(row.parent_post_id);
    }
    for (const row of parentRes.data ?? []) {
      if (row.parent_post_id) experimentParentPostIds.add(row.parent_post_id);
    }
  }

  const rows: QueueDisplayRow[] = deduped.map((p) => {
    const media = Array.isArray(p.media) ? (p.media as QueueMediaItem[]) : [];
    const meta = (p.generation_metadata ?? {}) as { image_prompt?: string | null };
    let experimentStatus: "parent" | "variant" | null = null;
    if (experimentVariantPostIds.has(p.id)) experimentStatus = "variant";
    else if (experimentParentPostIds.has(p.id)) experimentStatus = "parent";
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
      voice_score: p.voice_score,
      low_confidence: p.low_confidence ?? false,
      idea_id: p.idea_id,
      external_id: p.external_id,
      failure_reason: p.failure_reason,
      generation_metadata: p.generation_metadata,
      experiment_status: experimentStatus,
    };
  });

  // Phase 6.8: thread rows in posted/failed state are only here because
  // their idea has an active sibling. Slot them into the same section as
  // their sibling rows so the user sees the whole thread together.
  // Strategy: group by idea_id; if any row in an idea is pending → idea
  // lands in pending; else if any row is scheduled/failed → scheduled;
  // else (fully posted) → drop from the queue entirely.
  const ideaSectionOf = new Map<string, "pending" | "scheduled" | "drop">();
  const idToIdea = new Map<string, string | null>();
  for (const r of rows) {
    idToIdea.set(r.id, r.idea_id);
    if (!r.idea_id) continue;
    const cur = ideaSectionOf.get(r.idea_id);
    if (r.status === "pending_approval") {
      ideaSectionOf.set(r.idea_id, "pending");
    } else if (r.status === "scheduled" || r.status === "failed") {
      if (cur !== "pending") ideaSectionOf.set(r.idea_id, "scheduled");
    } else if (!cur) {
      ideaSectionOf.set(r.idea_id, "drop");
    }
  }

  function sectionForRow(r: QueueDisplayRow): "pending" | "scheduled" | "drop" {
    if (r.idea_id) return ideaSectionOf.get(r.idea_id) ?? "drop";
    if (r.status === "pending_approval") return "pending";
    if (r.status === "scheduled") return "scheduled";
    return "drop";
  }

  const pending = rows.filter((r) => sectionForRow(r) === "pending");
  const scheduled = rows.filter((r) => sectionForRow(r) === "scheduled");

  // Phase 6.10: pre-render per-post hashtag chip rows so the client
  // QueueRow component can just slot them in. We only build slots for
  // pending posts (scheduled is read-only). Server components render
  // serially here; for typical queue sizes (10–30 pending posts) this
  // is one DB roundtrip per channel-in-view via the recommender.
  // Phase 6.8: skip hashtag suggestions for thread tweets — X threads
  // are explicitly no-hashtags (the algorithm penalises them) and the
  // chip row would clutter the per-tweet editor.
  const hashtagSlots = new Map<string, React.ReactNode>();
  for (const p of pending) {
    if (readThreadMeta(p.generation_metadata) !== null) continue;
    hashtagSlots.set(
      p.id,
      <HashtagSuggestionsServer
        workspaceId={ws.id}
        postId={p.id}
        channel={p.channel}
        text={p.text}
      />,
    );
  }

  return (
    <div className="space-y-10">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="label-eyebrow">Drafts &amp; schedule</p>
          <h1 className="text-3xl font-semibold tracking-tight">Approval queue</h1>
          <p className="text-sm text-muted-foreground">
            Approve, edit, or reject. Approved drafts go straight to the schedule — you keep the kill switch.
          </p>
        </div>
        <Link
          href="/queue/new"
          className="inline-flex h-9 shrink-0 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity duration-200 hover:opacity-90"
        >
          New post
        </Link>
      </header>

      <Section
        title="Pending approval"
        count={pending.length}
        empty={
          <EmptyState
            icon="inbox"
            title="Inbox zero."
            description={
              <>
                Generate a plan to seed the queue with drafts, or{" "}
                <Link
                  href="/settings/events"
                  className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
                >
                  send a webhook event
                </Link>{" "}
                to auto-fill it.
              </>
            }
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
        {renderGrouped(pending, hashtagSlots)}
      </Section>

      <Section
        title="Scheduled"
        count={scheduled.length}
        empty={
          <EmptyState
            icon="calendar"
            title="Nothing on the schedule."
            description="Approve a draft above and it'll line up here — revoke any time before it goes live."
            action={
              <Link
                href="/queue/new"
                className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity duration-200 hover:opacity-90"
              >
                New post
              </Link>
            }
          />
        }
      >
        {renderGrouped(scheduled, null)}
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
function renderGrouped(
  rows: QueueDisplayRow[],
  hashtagSlots: Map<string, React.ReactNode> | null,
): React.ReactNode {
  type Group =
    | { kind: "single"; row: QueueDisplayRow; sortKey: string }
    | { kind: "idea"; ideaId: string; variants: QueueDisplayRow[]; sortKey: string }
    | { kind: "thread"; ideaId: string; tweets: ThreadTweetRow[]; theme: string | null; sortKey: string };

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
    // Phase 6.8: thread detection. Every row carries thread meta and
    // sits on channel='x' ⇒ this is a thread, not a cross-channel idea.
    const allThread = variants.every(
      (v) => v.channel === "x" && readThreadMeta(v.generation_metadata) !== null,
    );
    if (allThread && variants.length >= 2) {
      const tweets: ThreadTweetRow[] = variants
        .map((v) => {
          const m = readThreadMeta(v.generation_metadata)!;
          return {
            id: v.id,
            text: v.text,
            status: v.status,
            scheduled_at: v.scheduled_at,
            external_id: v.external_id,
            failure_reason: v.failure_reason,
            tweet_index: m.tweet_index,
            total_tweets: m.total_tweets,
            role: m.role,
          };
        })
        .sort((a, b) => a.tweet_index - b.tweet_index);
      const earliest = variants.map(sortKeyOf).sort()[0] ?? "";
      const theme = variants.find((v) => v.theme)?.theme ?? null;
      groups.push({ kind: "thread", ideaId, tweets, theme, sortKey: earliest });
      continue;
    }
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

  return groups.map((g) => {
    if (g.kind === "thread") {
      return (
        <ThreadBuilderRow
          key={`thread-${g.ideaId}`}
          ideaId={g.ideaId}
          tweets={g.tweets}
          theme={g.theme}
        />
      );
    }
    if (g.kind === "idea") {
      return (
        <QueueIdeaRow
          key={`idea-${g.ideaId}`}
          ideaId={g.ideaId}
          variants={g.variants}
          hashtagSlots={hashtagSlots ?? undefined}
        />
      );
    }
    return (
      <QueueRow
        key={g.row.id}
        post={g.row}
        hashtagRow={hashtagSlots?.get(g.row.id)}
      />
    );
  });
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
