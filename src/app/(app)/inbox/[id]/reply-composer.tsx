"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { draftReplyAction, sendReplyAction } from "./actions";

// Phase 4.5 — reply composer client component.
//
// Two-stage interaction:
//   1. "Draft with voice" — calls draftReplyAction, populates 1-2
//      candidate buttons. Clicking a candidate fills the textarea.
//   2. "Send reply" — calls sendReplyAction with the textarea contents.
//      THIS IS THE ONLY USER ACTION THAT SENDS.
//
// We never auto-trigger the draft on mount and we never auto-send a
// draft. Both stages require a click. Mirrors the hard rule documented
// in src/lib/interactions/draft-reply.ts.

interface ReplyComposerProps {
  interactionId: string;
  initialDrafts: string[];
  alreadyReplied: boolean;
  initialText?: string;
}

export function ReplyComposer({
  interactionId,
  initialDrafts,
  alreadyReplied,
  initialText = "",
}: ReplyComposerProps) {
  const router = useRouter();
  const [drafts, setDrafts] = useState<string[]>(initialDrafts);
  const [text, setText] = useState(initialText);
  const [error, setError] = useState<string | null>(null);
  const [draftingPending, startDrafting] = useTransition();
  const [sendingPending, startSending] = useTransition();

  function onDraft() {
    setError(null);
    startDrafting(async () => {
      const res = await draftReplyAction(interactionId);
      if (res.error) {
        setError(res.error);
        return;
      }
      setDrafts(res.drafts);
      if (res.drafts.length > 0 && !text) {
        setText(res.drafts[0] ?? "");
      }
    });
  }

  function onSend() {
    if (!text.trim()) {
      setError("Add some text to send.");
      return;
    }
    setError(null);
    startSending(async () => {
      const res = await sendReplyAction(interactionId, text);
      if (res.error) {
        setError(res.error);
        return;
      }
      router.push("/inbox");
      router.refresh();
    });
  }

  if (alreadyReplied) {
    return (
      <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm text-emerald-700 dark:text-emerald-400">
        You replied to this interaction.
      </div>
    );
  }

  const sending = sendingPending;
  const drafting = draftingPending;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Compose reply</h3>
        <button
          type="button"
          onClick={onDraft}
          disabled={drafting || sending}
          className="inline-flex h-8 items-center rounded-md border px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          {drafting ? "Drafting…" : drafts.length > 0 ? "Re-draft" : "Draft with voice"}
        </button>
      </div>
      {drafts.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">
            Suggestions — click to fill the editor. Edit before sending.
          </p>
          <ul className="space-y-1.5">
            {drafts.map((d, i) => (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => setText(d)}
                  className="block w-full rounded-md border bg-card px-3 py-2 text-left text-sm transition-colors hover:bg-muted/40"
                >
                  {d}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        placeholder="Type your reply here. Drafts are suggestions — this is your message."
        className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-foreground/10"
      />
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Replies always require a click. No auto-send, ever.
        </p>
        <button
          type="button"
          onClick={onSend}
          disabled={sending || drafting || !text.trim()}
          className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {sending ? "Sending…" : "Send reply"}
        </button>
      </div>
    </div>
  );
}
