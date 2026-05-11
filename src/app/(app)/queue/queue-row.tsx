"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { approvePostAction, editPostAction, rejectPostAction, revokePostAction } from "./actions";

interface PostRow {
  id: string;
  text: string;
  theme: string | null;
  scheduled_at: string | null;
  status: string;
  channel: string;
}

export function QueueRow({ post }: { post: PostRow }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(post.text);
  const [error, setError] = useState<string | null>(null);

  function run(action: () => Promise<{ error: string | null }>) {
    start(async () => {
      const result = await action();
      if (result.error) {
        setError(result.error);
        return;
      }
      setError(null);
      router.refresh();
    });
  }

  const isPending = post.status === "pending_approval";
  const isScheduled = post.status === "scheduled";

  return (
    <li className="space-y-3 px-4 py-4 text-sm">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {post.channel} {post.theme ? `· #${post.theme}` : ""} ·{" "}
          {post.scheduled_at ? post.scheduled_at.slice(0, 16).replace("T", " ") : "no time"}
        </span>
        <span className="rounded-md border px-2 py-0.5 text-[10px] uppercase">{post.status}</span>
      </div>

      {editing ? (
        <Textarea
          rows={4}
          value={draft}
          maxLength={280}
          onChange={(event) => setDraft(event.target.value)}
        />
      ) : (
        <p className="whitespace-pre-wrap">{post.text}</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {isPending && !editing ? (
          <>
            <Button
              size="sm"
              disabled={pending}
              onClick={() => run(() => approvePostAction(post.id))}
            >
              Approve
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={pending}
              onClick={() => run(() => rejectPostAction(post.id))}
            >
              Reject
            </Button>
          </>
        ) : null}

        {isPending && editing ? (
          <>
            <Button
              size="sm"
              disabled={pending}
              onClick={() => run(async () => {
                const r = await editPostAction(post.id, draft);
                if (!r.error) setEditing(false);
                return r;
              })}
            >
              Save edit
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setDraft(post.text);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </>
        ) : null}

        {isScheduled ? (
          <Button
            size="sm"
            variant="destructive"
            disabled={pending}
            onClick={() => run(() => revokePostAction(post.id))}
          >
            Revoke
          </Button>
        ) : null}

        {error ? <span className="text-xs text-destructive">{error}</span> : null}
      </div>
    </li>
  );
}
