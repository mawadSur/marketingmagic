import Link from "next/link";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { EmptyState } from "@/components/ui/empty-state";
import { QueueIdeaRow, QueueRow, QueueVariationRow, type QueueMediaItem } from "./queue-row";
import { groupQueueRows, type QueueDisplayRow } from "./queue-grouping";
import { QueueTabs } from "./queue-tabs";
import { HashtagPillRow } from "@/components/hashtag-pill-row";
import { TagChipRow } from "@/components/tag-chip-row";
import { recommendHashtags } from "@/lib/hashtags/recommend";
import { extractHashtags } from "@/lib/hashtags/extract";
import { getChannelHashtagPolicy } from "@/lib/hashtags/rules";
import type { ChannelId } from "@/lib/channels/registry";
import type { HashtagSuggestion } from "@/lib/hashtags/schema";
import { ThreadBuilderRow } from "@/components/thread-builder-ui";
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
  tags: string[] | null;
  // Hormozi slice #4 — batch tag stamped on a "30 filmable variations" run
  // (migration 060). Variation drafts carry no idea_id; this groups the batch.
  variation_group_id: string | null;
}

export default async function QueuePage() {
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();
  const { data: posts } = await supabase
    .from("posts")
    .select(
      "id, text, theme, scheduled_at, status, channel, social_account_id, media, generation_metadata, voice_score, low_confidence, idea_id, external_id, failure_reason, tags, variation_group_id",
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
        "id, text, theme, scheduled_at, status, channel, social_account_id, media, generation_metadata, voice_score, low_confidence, idea_id, external_id, failure_reason, tags, variation_group_id",
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
      tags: Array.isArray(p.tags) ? p.tags : [],
      experiment_status: experimentStatus,
      variation_group_id: p.variation_group_id,
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
  // pending posts (scheduled is read-only).
  // Phase 6.8: skip hashtag suggestions for thread tweets — X threads
  // are explicitly no-hashtags (the algorithm penalises them) and the
  // chip row would clutter the per-tweet editor.
  //
  // Batch the recommender by channel: the suggestion set only depends on
  // (workspace × channel), not the individual post, so we fetch ONCE per
  // unique channel in view instead of once per post (the old per-post
  // path was an N+1 against hashtag_usage). Per-post draft tags are still
  // extracted locally (no DB) and surfaced first by HashtagPillRow.
  const hashtagPosts = pending.filter(
    (p) => readThreadMeta(p.generation_metadata) === null,
  );
  const VALID_HASHTAG_CHANNELS: ReadonlyArray<ChannelId> = [
    "x",
    "linkedin",
    "threads",
    "instagram",
    "bluesky",
  ];
  const channelsInView = Array.from(
    new Set(
      hashtagPosts
        .map((p) => p.channel as ChannelId)
        .filter((c) => VALID_HASHTAG_CHANNELS.includes(c)),
    ),
  );
  const suggestionsByChannel = new Map<ChannelId, HashtagSuggestion[]>();
  await Promise.all(
    channelsInView.map(async (ch) => {
      suggestionsByChannel.set(ch, await recommendHashtags(ws.id, ch));
    }),
  );

  const hashtagSlots = new Map<string, React.ReactNode>();
  for (const p of hashtagPosts) {
    const ch = p.channel as ChannelId;
    if (!VALID_HASHTAG_CHANNELS.includes(ch)) continue;
    const policy = getChannelHashtagPolicy(ch);
    const showsChips = policy.showChips || policy.recommendedCount[1] > 0;
    hashtagSlots.set(
      p.id,
      <HashtagPillRow
        postId={p.id}
        channel={ch}
        suggestions={showsChips ? suggestionsByChannel.get(ch) ?? [] : []}
        initialTags={extractHashtags(p.text)}
      />,
    );
  }

  // Migration 052: per-post auto-tags chip row, bound to the structured
  // posts.tags column. No DB fetch needed — tags are already on the row.
  // Same pending-only + non-thread gating as the hashtag hints above.
  const tagSlots = new Map<string, React.ReactNode>();
  for (const p of hashtagPosts) {
    const ch = p.channel as ChannelId;
    if (!VALID_HASHTAG_CHANNELS.includes(ch)) continue;
    const row = rows.find((r) => r.id === p.id);
    tagSlots.set(
      p.id,
      <TagChipRow postId={p.id} channel={ch} initialTags={row?.tags ?? []} />,
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

      <QueueTabs />

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
        {renderGrouped(pending, hashtagSlots, tagSlots)}
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
        {renderGrouped(scheduled, null, null)}
      </Section>
    </div>
  );
}

/**
 * Render the grouped queue. The grouping DECISION (idea / thread / variation
 * batch / standalone) lives in groupQueueRows (./queue-grouping, pure +
 * unit-tested); this function only maps each group to its row component.
 */
function renderGrouped(
  rows: QueueDisplayRow[],
  hashtagSlots: Map<string, React.ReactNode> | null,
  tagSlots: Map<string, React.ReactNode> | null,
): React.ReactNode {
  const groups = groupQueueRows(rows);

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
          tagSlots={tagSlots ?? undefined}
        />
      );
    }
    if (g.kind === "variation") {
      return (
        <QueueVariationRow
          key={`variation-${g.groupId}`}
          groupId={g.groupId}
          variations={g.variations}
          hashtagSlots={hashtagSlots ?? undefined}
          tagSlots={tagSlots ?? undefined}
        />
      );
    }
    return (
      <QueueRow
        key={g.row.id}
        post={g.row}
        hashtagRow={hashtagSlots?.get(g.row.id)}
        tagRow={tagSlots?.get(g.row.id)}
      />
    );
  });
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
