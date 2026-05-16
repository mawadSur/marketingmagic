import Link from "next/link";
import { notFound } from "next/navigation";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { Badge, ChannelBadge } from "@/components/ui/badge";
import { bandForScore } from "@/lib/interactions/schema";
import { markReadAction } from "../actions";
import { ReplyComposer } from "./reply-composer";
import { UseAsSourceButton } from "./use-as-source-button";
import type { Database } from "@/lib/db/types";
import { MetaAppReviewPendingError } from "@/lib/interactions/errors";

export const dynamic = "force-dynamic";

type InteractionRow = Database["public"]["Tables"]["interactions"]["Row"];

export default async function InteractionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();

  const { data: interaction } = await supabase
    .from("interactions")
    .select("*")
    .eq("id", id)
    .eq("workspace_id", ws.id)
    .maybeSingle();
  if (!interaction) notFound();

  // Auto-mark as read on open (fire-and-forget — failure is non-fatal).
  if (interaction.status === "unread") {
    await markReadAction(interaction.id);
  }

  // Parent post for thread context (when this is a reply to one of our
  // own posts).
  let parentPostText: string | null = null;
  if (interaction.parent_post_id) {
    const { data: parent } = await supabase
      .from("posts")
      .select("text, posted_at")
      .eq("id", interaction.parent_post_id)
      .maybeSingle();
    parentPostText = parent?.text ?? null;
  }

  // Meta App Review banner — IG/Threads detail pages show the inbound
  // but block the reply composer.
  const metaPending =
    interaction.channel === "instagram" || interaction.channel === "threads";

  const band = bandForScore(interaction.priority_score);
  const priorityVariant =
    band === "high" ? "danger" : band === "medium" ? "warning" : "muted";

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <Link
          href="/inbox"
          className="text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          ← Back to inbox
        </Link>
        <div className="flex flex-wrap items-center gap-2 pt-2 text-xs">
          <ChannelBadge channel={interaction.channel} />
          <Badge variant={priorityVariant}>
            {band === "high" ? "high priority" : band === "medium" ? "med priority" : "low priority"}
          </Badge>
          <Badge variant={interaction.status === "replied" ? "success" : "muted"}>
            {interaction.status}
          </Badge>
        </div>
        <h1 className="pt-1 text-2xl font-semibold tracking-tight">
          @{interaction.author_handle}
          {interaction.author_display_name ? (
            <span className="ml-2 text-base font-normal text-muted-foreground">
              {interaction.author_display_name}
            </span>
          ) : null}
        </h1>
        <p className="text-xs text-muted-foreground tabular-nums">
          {interaction.received_at.slice(0, 16).replace("T", " ")}
          {interaction.priority_score != null
            ? ` · priority ${Math.round(interaction.priority_score)}/100`
            : null}
        </p>
      </header>

      {parentPostText ? (
        <section className="space-y-2">
          <p className="label-eyebrow">In reply to your post</p>
          <blockquote className="rounded-md border-l-2 border-muted bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
            {parentPostText}
          </blockquote>
        </section>
      ) : null}

      <section className="space-y-2">
        <p className="label-eyebrow">Their message</p>
        <div className="whitespace-pre-wrap rounded-md border bg-card px-4 py-3 text-sm">
          {interaction.body}
        </div>
      </section>

      {metaPending ? (
        <MetaPendingNotice channel={interaction.channel} />
      ) : (
        <section className="space-y-2">
          <ReplyComposer
            interactionId={interaction.id}
            initialDrafts={[]}
            alreadyReplied={interaction.status === "replied"}
          />
        </section>
      )}

      <section className="flex flex-wrap items-center gap-3 border-t pt-4">
        <UseAsSourceButton interactionId={interaction.id} />
        <Link
          href="/inbox"
          className="text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          Back to inbox →
        </Link>
      </section>
    </div>
  );
}

function MetaPendingNotice({ channel }: { channel: InteractionRow["channel"] }) {
  // We construct the error at render so the copy stays in lockstep with
  // the helper that's actually thrown server-side. No state — this is
  // an SSR-only banner.
  const err = new MetaAppReviewPendingError(
    channel === "instagram" ? "instagram_manage_comments" : "threads_manage_replies",
  );
  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-700 dark:text-amber-400">
      <p className="font-medium">Reply path pending Meta App Review</p>
      <p className="mt-1 text-xs">{err.message}</p>
    </div>
  );
}
