"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge, ChannelBadge, statusBadgeLabel, statusBadgeVariant } from "@/components/ui/badge";
import type { RejectionReason } from "@/lib/db/types";
import { maxCharsFor } from "@/lib/channels/registry";
import {
  approveAllVariantsAction,
  approveAllVariationsAction,
  approvePostAction,
  clearPostImageAction,
  editPostAction,
  generatePostImageAction,
  publishNowAction,
  rejectPostAction,
  reschedulePostAction,
  revokePostAction,
  runQuickExperimentAction,
  uploadPostImageAction,
} from "./actions";
import { generateVariationsAction } from "@/lib/variations/actions";

// Time helpers — the DB stores scheduled_at as a UTC ISO instant; the user
// thinks in their own timezone. We render + edit in local time and convert
// back to UTC on save. datetime-local input value is "YYYY-MM-DDTHH:mm" in
// local time, which `new Date()` parses as local → toISOString() gives UTC.
function toLocalInputValue(iso: string | null): string {
  const d = iso ? new Date(iso) : new Date(Date.now() + 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function formatLocal(iso: string | null): string {
  if (!iso) return "no time set";
  return new Date(iso).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

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
  voice_score: number | null;
  low_confidence: boolean;
  // Phase 6B — when true, this row already belongs to an experiment
  // (it's a variant of someone else's parent OR it IS the parent of
  // an active experiment). Suppresses the "Run Quick Experiment"
  // button so we don't recursively spawn experiments-of-experiments.
  experiment_status?: "parent" | "variant" | null;
}

// Phase 6.10: server-rendered hashtag chip row, passed in as a slot so
// the QueueRow client component stays free of async data fetching. The
// parent server page is responsible for constructing the node.
//
// Migration 052: `tagRow` is the parallel slot for the STRUCTURED auto-tags
// chip row (posts.tags). Same pattern — built server-side, slotted in here.
export interface QueueRowSlots {
  hashtagRow?: React.ReactNode;
  tagRow?: React.ReactNode;
}

const REJECTION_REASONS: Array<{ value: RejectionReason; label: string; helper: string }> = [
  { value: "off_voice", label: "Off-voice", helper: "Didn't sound like the brand." },
  { value: "wrong_theme", label: "Wrong theme", helper: "Off-strategy for this audience." },
  { value: "factually_wrong", label: "Factually wrong", helper: "Made-up claim or bad number." },
  { value: "other", label: "Other", helper: "Use the note to explain." },
];

export function QueueRow({
  post,
  hashtagRow,
  tagRow,
}: {
  post: PostRow;
} & QueueRowSlots) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(post.text);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState<RejectionReason | null>(null);
  const [rejectNote, setRejectNote] = useState("");

  // Reschedule (edit day/time) state.
  const [timeEditing, setTimeEditing] = useState(false);
  const [timeDraft, setTimeDraft] = useState(() => toLocalInputValue(post.scheduled_at));

  // Image-gen state. `prompt` is what the user types/edits; seeded from the
  // saved media's prompt (when an image already exists), else from Claude's
  // suggested image_prompt in generation_metadata. The seed is a useState
  // INITIALIZER (not a value), so a later router.refresh() never clobbers what
  // the user has typed — fixes the "value disappears" bug where edits were
  // being reset on the post-generate refresh.
  const seedPrompt = post.media[0]?.prompt ?? post.image_prompt ?? "";
  const [imagePrompt, setImagePrompt] = useState(seedPrompt);
  const [imageBusy, imageStart] = useTransition();
  const [imageError, setImageError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // "Suggest a prompt" helper — for when there's no pre-filled prompt to start
  // from. We already have Claude's plan-time suggestion (post.image_prompt);
  // if even that's missing, fall back to a concrete visual seed built from the
  // post's theme/copy so the user has something to edit instead of a blank box.
  function suggestImagePrompt() {
    const fallback =
      post.image_prompt?.trim() ||
      (post.theme
        ? `A clean, on-brand visual representing "${post.theme}".`
        : `A clean, on-brand visual that complements: ${post.text.slice(0, 120)}`);
    setImagePrompt(fallback);
    setImageError(null);
  }

  // Phase 6B — Quick Experiment spawn state. Sits on its own transition
  // so kicking off a (slow) Claude call doesn't block the approve/edit
  // buttons. Result message persists in-row until the user navigates
  // away or hits the queue refresh.
  const [expBusy, expStart] = useTransition();
  const [expFlash, setExpFlash] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  // Hormozi slices #3+#4 — "Generate 30 variations". Own transition so the
  // (slow) hook×body matrix call doesn't block approve/edit. Flash persists
  // in-row until the next queue refresh.
  const [varBusy, varStart] = useTransition();
  const [varFlash, setVarFlash] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  // "Publish now" — manual override that skips the up-to-5-min wait for the
  // cron tick. Own transition so a (potentially slow) platform call doesn't
  // disable the unrelated approve/edit/reject buttons.
  const [publishBusy, publishStart] = useTransition();
  function publishNow() {
    setError(null);
    publishStart(async () => {
      const r = await publishNowAction(post.id);
      if (r.error) {
        setError(r.error);
        return;
      }
      router.refresh();
    });
  }

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

  function onFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset the input so picking the same file again still fires onChange.
    e.target.value = "";
    setImageError(null);
    imageStart(async () => {
      const fd = new FormData();
      fd.append("postId", post.id);
      fd.append("file", file);
      const result = await uploadPostImageAction(fd);
      if (result.error) {
        setImageError(result.error);
        return;
      }
      router.refresh();
    });
  }

  const isPending = post.status === "pending_approval";
  const isScheduled = post.status === "scheduled";
  // Day/time is editable while the post is still upcoming (draft or queued).
  const canReschedule = isPending || isScheduled;

  function saveReschedule() {
    if (!timeDraft) {
      setError("Pick a date and time.");
      return;
    }
    const iso = new Date(timeDraft).toISOString();
    run(async () => {
      const r = await reschedulePostAction(post.id, iso);
      if (!r.error) setTimeEditing(false);
      return r;
    });
  }
  const hasImage = post.mediaPublicUrl !== null;
  // Phase 6B — show the experiment CTA on scheduled posts that aren't
  // themselves variants of another experiment. Spec says "per row", and
  // the only rows that are eligible parents are scheduled ones (the
  // pending parent might still be edited / rejected; posted parents
  // don't show in the queue at all).
  const canRunExperiment = isScheduled && !post.experiment_status;

  function runExperiment() {
    setExpFlash(null);
    expStart(async () => {
      const r = await runQuickExperimentAction(post.id, 3);
      if (r.error) {
        setExpFlash({ kind: "err", msg: r.error });
        return;
      }
      setExpFlash({
        kind: "ok",
        msg: "Generated 3 variants. Find them in pending approval.",
      });
      router.refresh();
    });
  }

  // Spin this post into a hook×body matrix (default 10×3 = 30 filmable
  // variations), each traced to this post via parent_post_id + a shared
  // variation_group_id. Drafts land in pending approval for review.
  function generateVariations() {
    setVarFlash(null);
    varStart(async () => {
      const r = await generateVariationsAction(post.id);
      if (r.error) {
        setVarFlash({ kind: "err", msg: r.error });
        return;
      }
      setVarFlash({
        kind: "ok",
        msg: `Generated ${r.created} variations. Find them in pending approval.`,
      });
      router.refresh();
    });
  }

  return (
    <li className="space-y-3 px-4 py-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center gap-2">
          <ChannelBadge channel={post.channel} />
          {post.theme ? <span>#{post.theme}</span> : null}
          {timeEditing ? (
            <span className="flex items-center gap-1.5">
              <Input
                type="datetime-local"
                value={timeDraft}
                onChange={(e) => setTimeDraft(e.target.value)}
                className="h-7 w-auto px-2 py-0 text-xs"
              />
              <Button size="sm" className="h-7" disabled={pending} onClick={saveReschedule}>
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7"
                disabled={pending}
                onClick={() => {
                  setTimeDraft(toLocalInputValue(post.scheduled_at));
                  setTimeEditing(false);
                  setError(null);
                }}
              >
                Cancel
              </Button>
            </span>
          ) : (
            <span className="flex items-center gap-1.5">
              <span className="tabular-nums">{formatLocal(post.scheduled_at)}</span>
              {canReschedule ? (
                <button
                  type="button"
                  onClick={() => {
                    setTimeDraft(toLocalInputValue(post.scheduled_at));
                    setTimeEditing(true);
                  }}
                  className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  title="Edit the day and time this posts"
                >
                  Edit time
                </button>
              ) : null}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {post.low_confidence ? (
            <span
              title={
                post.voice_score !== null
                  ? `Voice match ${post.voice_score.toFixed(0)}/100 — review before approving`
                  : "Low confidence — review before approving"
              }
              className="rounded-md border border-amber-500/40 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950/30 dark:text-amber-400"
            >
              Low voice match
              {post.voice_score !== null ? ` · ${post.voice_score.toFixed(0)}` : ""}
            </span>
          ) : null}
          <Badge variant={statusBadgeVariant(post.status)}>
            {statusBadgeLabel(post.status)}
          </Badge>
        </div>
      </div>

      {editing ? (
        <Textarea
          rows={4}
          value={draft}
          maxLength={maxCharsFor(post.channel)}
          onChange={(event) => setDraft(event.target.value)}
        />
      ) : (
        <p className="whitespace-pre-wrap">{post.text}</p>
      )}

      {/* Phase 6.10: hashtag chip row, only in pending state and only
          when the parent passed a slot (so legacy renders stay clean). */}
      {isPending && hashtagRow ? hashtagRow : null}

      {/* Migration 052: structured auto-tags chip row, same gating. */}
      {isPending && tagRow ? tagRow : null}

      {/* Image block — only show in pending state (post-approval edits frozen). */}
      {isPending ? (
        <div className="space-y-2 rounded-md border bg-muted/30 p-3">
          {/* Fixed-aspect media area. The placeholder, the loading overlay, and
              the final image ALL live in this same 16:9 box, so swapping
              between them never changes the card's height — fixes the "card
              jumps / moves until the image is done" layout shift (CLS). */}
          <div className="relative aspect-video w-full overflow-hidden rounded-md border bg-muted/20">
            {hasImage ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={post.mediaPublicUrl!}
                alt={post.media[0]?.prompt ?? "Generated image"}
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
                No image yet — type a prompt below or upload one.
              </div>
            )}
            {/* Loading overlay — sits on top of whatever's in the box while a
                generation/upload is in flight, so the user gets clear feedback
                without the layout reflowing. */}
            {imageBusy ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/70 backdrop-blur-sm">
                <Loader2 className="h-6 w-6 animate-spin text-foreground/70" aria-hidden />
                <span className="text-xs font-medium text-muted-foreground">
                  {hasImage ? "Regenerating…" : "Generating your image…"}
                </span>
              </div>
            ) : null}
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor={`image-prompt-${post.id}`}
                className="text-xs font-medium text-muted-foreground"
              >
                Image prompt
              </label>
              {/* Helper: when the box is empty, offer a one-click suggested
                  prompt (Claude's plan-time suggestion, or a theme/copy-based
                  fallback) so the user isn't staring at a blank field. */}
              {imagePrompt.trim().length === 0 ? (
                <button
                  type="button"
                  onClick={suggestImagePrompt}
                  disabled={imageBusy}
                  className="inline-flex items-center gap-1 rounded text-xs font-medium text-primary transition-colors hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:opacity-50"
                >
                  <Wand2 className="h-3 w-3" aria-hidden />
                  Suggest a prompt
                </button>
              ) : null}
            </div>
            <Input
              id={`image-prompt-${post.id}`}
              value={imagePrompt}
              onChange={(e) => setImagePrompt(e.target.value)}
              placeholder="Describe the image you want…"
              maxLength={500}
              disabled={imageBusy}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={imageBusy || imagePrompt.trim().length < 3}
              onClick={() => runImage(imagePrompt)}
            >
              {imageBusy ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
                  Working…
                </>
              ) : hasImage ? (
                "Regenerate"
              ) : (
                "Generate image"
              )}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={imageBusy}
              onClick={() => fileInputRef.current?.click()}
            >
              Upload image
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              hidden
              onChange={onFileSelected}
            />
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
            <span className="text-xs text-muted-foreground">JPG / PNG / WebP, ≤5MB</span>
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
          loading="lazy"
          decoding="async"
          className="max-h-64 w-full rounded-md border object-cover"
        />
      ) : null}

      {isPending && rejecting ? (
        <div className="space-y-3 rounded-md border border-destructive/30 bg-destructive/5 p-3">
          <p className="text-xs font-medium text-destructive">Why reject this draft?</p>
          <div className="space-y-1.5">
            {REJECTION_REASONS.map((opt) => (
              <label
                key={opt.value}
                className="flex cursor-pointer items-start gap-2 rounded-md p-1.5 hover:bg-destructive/10"
              >
                <input
                  type="radio"
                  name={`reject-reason-${post.id}`}
                  value={opt.value}
                  checked={rejectReason === opt.value}
                  onChange={() => setRejectReason(opt.value)}
                  className="mt-0.5"
                />
                <span className="flex-1 text-xs">
                  <span className="font-medium text-foreground">{opt.label}</span>
                  <span className="ml-2 text-muted-foreground">{opt.helper}</span>
                </span>
              </label>
            ))}
          </div>
          <Textarea
            rows={2}
            value={rejectNote}
            maxLength={500}
            placeholder={
              rejectReason === "other"
                ? "Explain what was wrong (required for Other)."
                : "Optional: specifics — they feed back into the next plan generation."
            }
            onChange={(e) => setRejectNote(e.target.value)}
            className="text-xs"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={
                pending ||
                rejectReason === null ||
                (rejectReason === "other" && rejectNote.trim().length === 0)
              }
              onClick={() => {
                if (!rejectReason) return;
                const note = rejectNote.trim();
                run(async () => {
                  const r = await rejectPostAction(
                    post.id,
                    rejectReason,
                    note.length > 0 ? note : undefined,
                  );
                  if (!r.error) {
                    setRejecting(false);
                    setRejectReason(null);
                    setRejectNote("");
                  }
                  return r;
                });
              }}
            >
              Confirm reject
            </Button>
            {rejectReason === null ? (
              <span className="text-xs text-muted-foreground">Select a reason to continue.</span>
            ) : rejectReason === "other" && rejectNote.trim().length === 0 ? (
              <span className="text-xs text-muted-foreground">Required for &lsquo;Other&rsquo;.</span>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => {
                setRejecting(false);
                setRejectReason(null);
                setRejectNote("");
                setError(null);
              }}
            >
              Cancel
            </Button>
            {error ? <span className="text-xs text-destructive">{error}</span> : null}
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {isPending && !editing && !rejecting ? (
          <>
            <Button
              size="sm"
              disabled={pending || publishBusy}
              onClick={() => run(() => approvePostAction(post.id))}
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={pending || publishBusy}
              onClick={publishNow}
              title="Skip the schedule and publish this post right now."
            >
              {publishBusy ? "Publishing…" : "Publish now"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={pending}
              onClick={() => {
                setRejecting(true);
                setRejectReason(null);
                setRejectNote("");
                setError(null);
              }}
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
          <>
            <Button
              size="sm"
              variant="secondary"
              disabled={pending || publishBusy}
              onClick={publishNow}
              title="Skip the schedule and publish this post right now."
            >
              {publishBusy ? "Publishing…" : "Publish now"}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={pending || publishBusy}
              onClick={() => run(() => revokePostAction(post.id))}
            >
              Revoke
            </Button>
          </>
        ) : null}

        {canRunExperiment ? (
          <Button
            size="sm"
            variant="outline"
            disabled={expBusy}
            onClick={runExperiment}
            title="Generate 3 variants of this post and schedule them ≥48h apart. Directional, not statistically rigorous."
          >
            {expBusy ? "Generating variants…" : "Run Quick Experiment"}
          </Button>
        ) : null}

        {/* Hormozi slices #3+#4 — turn this post into 30 filmable variations,
            each traced back to it (parent_post_id + variation_group_id). Shown
            on any pending/scheduled post; the drafts land in pending approval. */}
        {(isPending || isScheduled) && !editing && !rejecting ? (
          <Button
            size="sm"
            variant="outline"
            disabled={varBusy}
            onClick={generateVariations}
            title="Turn this post into a 10×3 = 30 hook×body matrix of filmable variations. Each lands in pending approval, traced back to this post."
          >
            {varBusy ? "Generating 30 variations…" : "Generate 30 variations"}
          </Button>
        ) : null}

        {post.experiment_status === "variant" ? (
          <Badge variant="info" title="This post belongs to a Quick Experiment.">
            Experiment variant
          </Badge>
        ) : null}
        {post.experiment_status === "parent" ? (
          <Badge variant="info" title="A Quick Experiment is running off this post.">
            Experiment parent
          </Badge>
        ) : null}

        {expFlash ? (
          <span
            className={
              "text-xs " +
              (expFlash.kind === "err"
                ? "text-destructive"
                : "text-emerald-600 dark:text-emerald-400")
            }
          >
            {expFlash.msg}
          </span>
        ) : null}

        {varFlash ? (
          <span
            className={
              "text-xs " +
              (varFlash.kind === "err"
                ? "text-destructive"
                : "text-emerald-600 dark:text-emerald-400")
            }
          >
            {varFlash.msg}
          </span>
        ) : null}

        {error ? <span className="text-xs text-destructive">{error}</span> : null}
      </div>
    </li>
  );
}

// ─────────────────────────────────────────────────────────────
// QueueIdeaRow — one collapsible row representing a cross-channel idea.
// ─────────────────────────────────────────────────────────────
//
// Phase 2: a single "idea" fans out into N channel variants (X / LinkedIn /
// Threads / IG / Bluesky). The queue renders the idea as a collapsible
// header showing the channels involved + a single "Approve all variants"
// action; expanding the row stacks the per-variant editors (each a full
// QueueRow) so per-variant edit/approve/reject still works.

export function QueueIdeaRow({
  ideaId,
  variants,
  hashtagSlots,
  tagSlots,
}: {
  ideaId: string;
  variants: PostRow[];
  // Phase 6.10: per-variant hashtag chip row slot, keyed by post id.
  // The parent server page builds this map; the client component just
  // forwards each slot into its matching QueueRow.
  hashtagSlots?: Map<string, React.ReactNode>;
  // Migration 052: parallel per-variant auto-tags chip row slot, keyed by
  // post id. Same forwarding contract as hashtagSlots.
  tagSlots?: Map<string, React.ReactNode>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(true);
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const pendingCount = variants.filter((v) => v.status === "pending_approval").length;
  const scheduledCount = variants.filter((v) => v.status === "scheduled").length;
  const channels = Array.from(new Set(variants.map((v) => v.channel)));
  const theme = variants.find((v) => v.theme)?.theme ?? null;
  // Idea-level timestamp = earliest scheduled_at across the variants. Each
  // variant's own time still shows in its inner row.
  const earliestAt = variants
    .map((v) => v.scheduled_at)
    .filter((t): t is string => !!t)
    .sort()[0] ?? null;

  function approveAll() {
    start(async () => {
      const r = await approveAllVariantsAction(ideaId);
      if (r.error) {
        setError(r.error);
        setNotice(null);
        return;
      }
      setError(null);
      setNotice(r.approved > 0 ? `Approved ${r.approved} variant${r.approved === 1 ? "" : "s"}.` : "No pending variants left to approve.");
      router.refresh();
    });
  }

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
          <span className="font-medium text-foreground">Cross-channel idea</span>
          <span className="flex flex-wrap items-center gap-1">
            {channels.map((c) => (
              <ChannelBadge key={c} channel={c} />
            ))}
          </span>
          {theme ? <span>#{theme}</span> : null}
          {earliestAt ? (
            <span className="tabular-nums">{formatLocal(earliestAt)}</span>
          ) : null}
        </button>
        <div className="flex flex-wrap items-center gap-2">
          {pendingCount > 0 ? (
            <Badge variant="warning">{pendingCount} pending</Badge>
          ) : null}
          {scheduledCount > 0 ? (
            <Badge variant="success">{scheduledCount} scheduled</Badge>
          ) : null}
          {pendingCount > 0 ? (
            <Button size="sm" disabled={busy} onClick={approveAll}>
              {busy ? "Approving…" : `Approve all variants${pendingCount > 1 ? ` (${pendingCount})` : ""}`}
            </Button>
          ) : null}
        </div>
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {notice ? <p className="text-xs text-muted-foreground">{notice}</p> : null}

      {open ? (
        <ul className="divide-y rounded-md border bg-muted/20">
          {variants.map((v) => (
            <QueueRow
              key={v.id}
              post={v}
              hashtagRow={hashtagSlots?.get(v.id)}
              tagRow={tagSlots?.get(v.id)}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

// Hormozi slice #4 — a "Generate 30 variations" batch (one source post spun
// into a hook×body matrix). The drafts share a variation_group_id (migration
// 060) but carry NO idea_id, so the queue groups them here into one collapsible
// row instead of flooding pending-approval with 30 loose drafts.
//
// Mirrors QueueIdeaRow, but: (1) keyed by the batch tag, (2) bulk-approves via
// approveAllVariationsAction, (3) DEFAULTS COLLAPSED — a 30-draft burst is
// exploratory, so the creator opens it deliberately rather than scrolling past
// 30 expanded editors.
export function QueueVariationRow({
  groupId,
  variations,
  hashtagSlots,
  tagSlots,
}: {
  groupId: string;
  variations: PostRow[];
  hashtagSlots?: Map<string, React.ReactNode>;
  tagSlots?: Map<string, React.ReactNode>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const pendingCount = variations.filter((v) => v.status === "pending_approval").length;
  const scheduledCount = variations.filter((v) => v.status === "scheduled").length;
  // Every variation in a batch shares the source's channel + theme.
  const channel = variations[0]?.channel ?? null;
  const theme = variations.find((v) => v.theme)?.theme ?? null;
  const earliestAt = variations
    .map((v) => v.scheduled_at)
    .filter((t): t is string => !!t)
    .sort()[0] ?? null;

  function approveAll() {
    start(async () => {
      const r = await approveAllVariationsAction(groupId);
      if (r.error) {
        setError(r.error);
        setNotice(null);
        return;
      }
      setError(null);
      setNotice(
        r.approved > 0
          ? `Approved ${r.approved} variation${r.approved === 1 ? "" : "s"}.`
          : "No pending variations left to approve.",
      );
      router.refresh();
    });
  }

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
          <Wand2 className="h-3.5 w-3.5 text-primary" aria-hidden />
          <span className="font-medium text-foreground">
            {variations.length} filmable variation{variations.length === 1 ? "" : "s"}
          </span>
          {channel ? <ChannelBadge channel={channel} /> : null}
          {theme ? <span>#{theme}</span> : null}
          {earliestAt ? <span className="tabular-nums">{formatLocal(earliestAt)}</span> : null}
        </button>
        <div className="flex flex-wrap items-center gap-2">
          {pendingCount > 0 ? <Badge variant="warning">{pendingCount} pending</Badge> : null}
          {scheduledCount > 0 ? <Badge variant="success">{scheduledCount} scheduled</Badge> : null}
          {pendingCount > 0 ? (
            <Button size="sm" disabled={busy} onClick={approveAll}>
              {busy ? "Approving…" : `Approve all${pendingCount > 1 ? ` (${pendingCount})` : ""}`}
            </Button>
          ) : null}
        </div>
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {notice ? <p className="text-xs text-muted-foreground">{notice}</p> : null}

      {open ? (
        <ul className="divide-y rounded-md border bg-muted/20">
          {variations.map((v) => (
            <QueueRow
              key={v.id}
              post={v}
              hashtagRow={hashtagSlots?.get(v.id)}
              tagRow={tagSlots?.get(v.id)}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
