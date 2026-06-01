"use client";

import { useState, useTransition } from "react";
import Image from "next/image";
import type { PortalPost } from "@/lib/portal/data";
import type { RejectionReason } from "@/lib/db/types";
import { portalApproveAction, portalRejectAction } from "./actions";

const REJECTION_REASONS: Array<{ value: RejectionReason; label: string }> = [
  { value: "off_voice", label: "Off-voice" },
  { value: "wrong_theme", label: "Wrong theme" },
  { value: "factually_wrong", label: "Factually wrong" },
  { value: "other", label: "Other" },
];

export function PortalApprovals({
  token,
  posts,
  accent,
}: {
  token: string;
  posts: PortalPost[];
  accent: string;
}) {
  if (posts.length === 0) {
    return (
      <p className="rounded-lg border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
        Nothing waiting for your review right now. We&apos;ll email you when there&apos;s
        something new to approve.
      </p>
    );
  }
  return (
    <ul className="space-y-3">
      {posts.map((p) => (
        <PortalPostCard key={p.id} token={token} post={p} accent={accent} />
      ))}
    </ul>
  );
}

function PortalPostCard({
  token,
  post,
  accent,
}: {
  token: string;
  post: PortalPost;
  accent: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<"approved" | "rejected" | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState<RejectionReason>("off_voice");
  const [note, setNote] = useState("");

  if (done) {
    return (
      <li className="rounded-lg border bg-card px-4 py-3 text-sm text-muted-foreground">
        {done === "approved" ? "Approved — scheduled to publish." : "Rejected. Thanks for the feedback."}
      </li>
    );
  }

  function approve() {
    setError(null);
    startTransition(async () => {
      const res = await portalApproveAction(token, post.id);
      if (res.error) setError(res.error);
      else setDone("approved");
    });
  }

  function reject() {
    setError(null);
    startTransition(async () => {
      const res = await portalRejectAction(token, post.id, reason, note);
      if (res.error) setError(res.error);
      else setDone("rejected");
    });
  }

  return (
    <li className="space-y-3 rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="rounded bg-muted px-1.5 py-0.5 font-medium uppercase tracking-wide">
          {post.channel}
        </span>
        {post.theme ? <span>· {post.theme}</span> : null}
      </div>

      <p className="whitespace-pre-wrap text-sm leading-relaxed">{post.text}</p>

      {post.mediaPublicUrl ? (
        <Image
          src={post.mediaPublicUrl}
          alt=""
          width={480}
          height={300}
          className="max-h-72 w-auto rounded-md border object-contain"
          unoptimized
        />
      ) : null}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {rejecting ? (
        <div className="space-y-3 rounded-md border bg-muted/30 p-3">
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium text-muted-foreground">Why?</legend>
            {REJECTION_REASONS.map((r) => (
              <label key={r.value} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`reason-${post.id}`}
                  checked={reason === r.value}
                  onChange={() => setReason(r.value)}
                />
                {r.label}
              </label>
            ))}
          </fieldset>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            placeholder="Optional note for the team"
            className="min-h-[60px] w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={reject}
              disabled={pending}
              className="rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground disabled:opacity-50"
            >
              {pending ? "Sending…" : "Confirm reject"}
            </button>
            <button
              type="button"
              onClick={() => setRejecting(false)}
              disabled={pending}
              className="rounded-md border px-3 py-1.5 text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={approve}
            disabled={pending}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            style={{ backgroundColor: accent }}
          >
            {pending ? "Approving…" : "Approve"}
          </button>
          <button
            type="button"
            onClick={() => setRejecting(true)}
            disabled={pending}
            className="rounded-md border px-3 py-1.5 text-sm font-medium"
          >
            Reject
          </button>
        </div>
      )}
    </li>
  );
}
