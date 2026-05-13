"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  approvePostAction,
  clearPostImageAction,
  editPostAction,
  generatePostImageAction,
  rejectPostAction,
  revokePostAction,
} from "./actions";

export interface QueueMediaItem {
  kind: "image";
  storage_path: string;
  content_type: string;
  prompt: string;
  width?: number;
  height?: number;
}

interface PostRow {
  id: string;
  text: string;
  theme: string | null;
  scheduled_at: string | null;
  status: string;
  channel: string;
  media: QueueMediaItem[];
  image_prompt: string | null;
  mediaPublicUrl: string | null;
}

export function QueueRow({ post }: { post: PostRow }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(post.text);
  const [error, setError] = useState<string | null>(null);

  // Image-gen state. `prompt` is what the user types/edits; seeded from the
  // saved media's prompt (when an image already exists), else from Claude's
  // suggested image_prompt in generation_metadata.
  const seedPrompt = post.media[0]?.prompt ?? post.image_prompt ?? "";
  const [imagePrompt, setImagePrompt] = useState(seedPrompt);
  const [imageBusy, imageStart] = useTransition();
  const [imageError, setImageError] = useState<string | null>(null);

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

  function runImage(prompt: string) {
    imageStart(async () => {
      const result = await generatePostImageAction(post.id, prompt);
      if (result.error) {
        setImageError(result.error);
        return;
      }
      setImageError(null);
      router.refresh();
    });
  }

  function clearImage() {
    imageStart(async () => {
      const result = await clearPostImageAction(post.id);
      if (result.error) {
        setImageError(result.error);
        return;
      }
      setImageError(null);
      router.refresh();
    });
  }

  const isPending = post.status === "pending_approval";
  const isScheduled = post.status === "scheduled";
  const hasImage = post.mediaPublicUrl !== null;

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

      {/* Image block — only show in pending state (post-approval edits frozen). */}
      {isPending ? (
        <div className="space-y-2 rounded-md border bg-muted/30 p-3">
          {hasImage ? (
            <div className="space-y-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={post.mediaPublicUrl!}
                alt={post.media[0]?.prompt ?? "Generated image"}
                className="max-h-64 w-full rounded-md border object-cover"
              />
            </div>
          ) : (
            <div className="flex h-24 items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground">
              No image yet
            </div>
          )}

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">
              Image prompt
            </label>
            <Input
              value={imagePrompt}
              onChange={(e) => setImagePrompt(e.target.value)}
              placeholder="Describe the image you want…"
              maxLength={500}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={imageBusy || imagePrompt.trim().length < 3}
              onClick={() => runImage(imagePrompt)}
            >
              {imageBusy ? "Generating…" : hasImage ? "Regenerate" : "Generate image"}
            </Button>
            {hasImage ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={imageBusy}
                onClick={() => clearImage()}
              >
                Clear
              </Button>
            ) : null}
            {imageError ? (
              <span className="text-xs text-destructive">{imageError}</span>
            ) : null}
          </div>
        </div>
      ) : hasImage ? (
        /* Scheduled posts: image is locked, just show preview. */
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={post.mediaPublicUrl!}
          alt={post.media[0]?.prompt ?? "Generated image"}
          className="max-h-64 w-full rounded-md border object-cover"
        />
      ) : null}

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
