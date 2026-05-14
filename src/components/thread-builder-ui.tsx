"use client";

// Phase 6.8 — collapsible /queue row for an X thread.
//
// Single approval gate: one "Approve thread" button approves every
// pending tweet. Per-tweet inline edit + a "Regenerate hook" button
// for tweet 1 only. Partial-publish state shows a "X of N posted —
// retry?" affordance.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge, ChannelBadge, statusBadgeLabel, statusBadgeVariant } from "@/components/ui/badge";
import { X_TWEET_MAX, HOOK_MAX } from "@/lib/threads/schema";
import {
  approveThreadAction,
  editThreadTweetAction,
  regenerateHookAction,
  retryPartialThreadAction,
} from "@/app/(app)/queue/thread-actions";

export interface ThreadTweetRow {
  id: string;
  text: string;
  status: string;
  scheduled_at: string | null;
  external_id: string | null;
  failure_reason: string | null;
  tweet_index: number;
  total_tweets: number;
  role: "hook" | "body" | "close";
}

export function ThreadBuilderRow({
  ideaId,
  tweets,
  theme,
}: {
  ideaId: string;
  tweets: ThreadTweetRow[];
  theme: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(true);
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Sort by tweet_index for stable rendering.
  const sorted = [...tweets].sort((a, b) => a.tweet_index - b.tweet_index);
  const total = sorted[0]?.total_tweets ?? sorted.length;
  const postedCount = sorted.filter((t) => t.external_id !== null).length;
  const pendingCount = sorted.filter((t) => t.status === "pending_approval").length;
  const scheduledCount = sorted.filter((t) => t.status === "scheduled").length;
  const failedCount = sorted.filter((t) => t.status === "failed").length;
  const isPartial = postedCount > 0 && postedCount < total && failedCount > 0;
  const earliestAt =
    sorted
      .map((t) => t.scheduled_at)
      .filter((t): t is string => !!t)
      .sort()[0] ?? null;

  function approve() {
    start(async () => {
      const r = await approveThreadAction(ideaId);
      if (r.error) {
        setError(r.error);
        setNotice(null);
        return;
      }
      setError(null);
      setNotice(
        r.approved > 0
          ? `Approved ${r.approved} tweet${r.approved === 1 ? "" : "s"} — thread will post sequentially.`
          : "Nothing pending to approve.",
      );
      router.refresh();
    });
  }

  function retry() {
    start(async () => {
      const r = await retryPartialThreadAction(ideaId);
      if (r.error) {
        setError(r.error);
        setNotice(null);
        return;
      }
      setError(null);
      setNotice(
        r.rearmed > 0
          ? `Re-armed ${r.rearmed} tweet${r.rearmed === 1 ? "" : "s"} — next cron run will resume the thread.`
          : "No failed tweets to retry.",
      );
      router.refresh();
    });
  }

  function regenHook() {
    start(async () => {
      const r = await regenerateHookAction(ideaId);
      if (r.error) {
        setError(r.error);
        setNotice(null);
        return;
      }
      setError(null);
      setNotice("Hook regenerated.");
      router.refresh();
    });
  }

  // Status summary in the header. Posted count carries the most signal
  // on a partial-publish; otherwise we surface the pending/scheduled split.
  const headerStatus = (() => {
    if (postedCount === total) return `${total} of ${total} posted`;
    if (isPartial) return `${postedCount} of ${total} posted — retry?`;
    if (failedCount > 0) return `${failedCount} failed`;
    if (scheduledCount > 0 && pendingCount === 0) return `Scheduled · ${total} tweets`;
    if (pendingCount > 0) return `${pendingCount} of ${total} pending approval`;
    return `${total} tweets`;
  })();

  return (
    <li className="space-y-2 px-4 py-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex flex-wrap items-center gap-2 text-left text-xs text-muted-foreground hover:text-foreground"
          aria-expanded={open}
        >
          <span aria-hidden className="inline-block w-3 select-none tabular-nums">
            {open ? "▾" : "▸"}
          </span>
          <span className="font-medium text-foreground">X thread</span>
          <ChannelBadge channel="x" />
          {theme ? <span>#{theme}</span> : null}
          <span>{headerStatus}</span>
          {earliestAt ? (
            <span className="tabular-nums">{earliestAt.slice(0, 16).replace("T", " ")}</span>
          ) : null}
        </button>
        <div className="flex flex-wrap items-center gap-2">
          {failedCount > 0 ? <Badge variant="danger">{failedCount} failed</Badge> : null}
          {pendingCount > 0 ? <Badge variant="warning">{pendingCount} pending</Badge> : null}
          {scheduledCount > 0 ? <Badge variant="success">{scheduledCount} scheduled</Badge> : null}
          {postedCount > 0 ? <Badge variant="success">{postedCount} posted</Badge> : null}
          {pendingCount > 0 ? (
            <Button size="sm" disabled={busy} onClick={approve}>
              {busy ? "Approving…" : `Approve thread${total > 1 ? ` (${total})` : ""}`}
            </Button>
          ) : null}
          {pendingCount > 0 ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={regenHook}>
              Regenerate hook
            </Button>
          ) : null}
          {isPartial ? (
            <Button size="sm" variant="destructive" disabled={busy} onClick={retry}>
              {busy ? "Retrying…" : `Retry remaining (${failedCount})`}
            </Button>
          ) : null}
        </div>
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {notice ? <p className="text-xs text-muted-foreground">{notice}</p> : null}

      {open ? (
        <ul className="divide-y rounded-md border bg-muted/20">
          {sorted.map((t) => (
            <ThreadTweetEditor key={t.id} tweet={t} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

// ─────────────────────────────────────────────────────────────
// One tweet inside the thread — inline edit, status pill, role label.
// ─────────────────────────────────────────────────────────────
function ThreadTweetEditor({ tweet }: { tweet: ThreadTweetRow }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tweet.text);
  const [error, setError] = useState<string | null>(null);

  const cap = tweet.role === "hook" ? HOOK_MAX : X_TWEET_MAX;
  const canEdit = tweet.status === "pending_approval";
  const charsLeft = cap - draft.length;
  const over = charsLeft < 0;

  function save() {
    start(async () => {
      const r = await editThreadTweetAction(tweet.id, draft);
      if (r.error) {
        setError(r.error);
        return;
      }
      setError(null);
      setEditing(false);
      router.refresh();
    });
  }

  return (
    <li className="space-y-2 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="rounded-md border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] tabular-nums">
          {tweet.tweet_index}/{tweet.total_tweets}
        </span>
        <span className="rounded-md border bg-muted/30 px-1.5 py-0.5 text-[10px] font-medium">
          {tweet.role}
        </span>
        <Badge variant={statusBadgeVariant(tweet.status)}>{statusBadgeLabel(tweet.status)}</Badge>
        {tweet.external_id ? (
          <span className="font-mono text-[10px]">id: {tweet.external_id.slice(0, 12)}…</span>
        ) : null}
      </div>

      {editing ? (
        <div className="space-y-1">
          <Textarea
            rows={3}
            value={draft}
            maxLength={cap}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>
              {tweet.role === "hook" ? `Hook cap ${HOOK_MAX}` : `Tweet cap ${X_TWEET_MAX}`}
            </span>
            <span className={over ? "text-destructive" : ""}>{charsLeft} left</span>
          </div>
        </div>
      ) : (
        <p className="whitespace-pre-wrap">{tweet.text}</p>
      )}

      {tweet.failure_reason ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1 text-[11px] text-destructive">
          {tweet.failure_reason}
        </p>
      ) : null}

      {canEdit ? (
        <div className="flex flex-wrap items-center gap-2">
          {editing ? (
            <>
              <Button size="sm" disabled={busy || over || draft.trim().length === 0} onClick={save}>
                {busy ? "Saving…" : "Save"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setDraft(tweet.text);
                  setEditing(false);
                  setError(null);
                }}
              >
                Cancel
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
          {error ? <span className="text-xs text-destructive">{error}</span> : null}
        </div>
      ) : null}
    </li>
  );
}
