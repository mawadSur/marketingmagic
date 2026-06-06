"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import type { PostingVerdict, PostingVerdictLevel } from "@/lib/groups/posting-rules";
import type { GroupView, GroupDraftView } from "./groups-manager";
import {
  createManualDraftAction,
  generateGroupDraftsAction,
  markDraftPostedAction,
  dismissDraftAction,
  updateDraftTextAction,
  deleteGroupAction,
} from "./actions";

// Colour + icon per verdict level. Mirrors the app's amber/emerald/sky banner
// palette used elsewhere (channels page, low-voice chip).
const VERDICT_STYLE: Record<PostingVerdictLevel, { box: string; icon: string }> = {
  good: { box: "border-emerald-500/40 bg-emerald-500/5 text-emerald-800 dark:text-emerald-300", icon: "✅" },
  caution: { box: "border-amber-500/40 bg-amber-500/5 text-amber-800 dark:text-amber-300", icon: "⚠️" },
  // Explicit light/dark reds so the most urgent state stays high-contrast in
  // dark mode (the bare `text-destructive` token is too dim on a dark bg).
  blocked: { box: "border-red-500/40 bg-red-500/5 text-red-700 dark:text-red-400", icon: "🚫" },
};

function VerdictBanner({ verdict }: { verdict: PostingVerdict }) {
  const style = VERDICT_STYLE[verdict.level];
  return (
    <div className={`rounded-md border p-3 text-sm ${style.box}`}>
      <p className="font-medium">
        <span aria-hidden className="mr-1.5">{style.icon}</span>
        {verdict.headline}
      </p>
      <p className="mt-1 text-xs opacity-90">{verdict.detail}</p>
      {verdict.tips.length > 0 ? (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs opacity-90">
          {verdict.tips.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function PROMO_LABEL(policy: GroupView["promo_policy"]): string {
  if (policy === "open") return "Promo: any day";
  if (policy === "value_only") return "Value-only";
  return "Promo: limited days";
}

// Recommended day + time-of-day to post in this group. The soonest slot is
// highlighted ("today" or the next allowed day); the rest of the week's
// allowed days follow as quieter chips.
function RecommendedSchedule({ group }: { group: GroupView }) {
  const { recommendedSlot: next, upcomingSlots } = group;
  // Drop the soonest slot from the "also" chips so we don't repeat it.
  const rest = upcomingSlots.filter((s) => s.isoWeekday !== next.isoWeekday);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span aria-hidden>🕒</span>
      <span>
        Best time to post:{" "}
        <span className="font-medium text-foreground">
          {next.isToday ? "Today" : next.weekdayName}, {next.timeRange}
        </span>
      </span>
      {rest.length > 0 ? (
        <span className="text-muted-foreground">
          · also {rest.map((s) => `${s.weekdayShort} ${s.timeRange}`).join(", ")}
        </span>
      ) : null}
    </div>
  );
}

function DraftRow({
  draft,
  groupUrl,
  groupName,
}: {
  draft: GroupDraftView;
  groupUrl: string;
  groupName: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(draft.text);
  const [copied, setCopied] = useState(false);
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isPosted = draft.status === "posted";

  async function copyAndOpen() {
    setError(null);
    try {
      await navigator.clipboard.writeText(draft.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard can be blocked (permissions / insecure context). The text is
      // still visible to select manually; surface a hint rather than failing.
      setError("Couldn't auto-copy — select the text above and copy it manually.");
    }
    // Open the group in a new tab so the operator can paste straight in.
    // window.open returns null when a popup blocker stops it — only treat the
    // group as "opened" when the tab actually opened, and tell the user
    // otherwise (the link to the group is still on the card as a fallback).
    const win = window.open(groupUrl, "_blank", "noopener,noreferrer");
    if (win) {
      setOpened(true);
    } else {
      setError("Couldn't open the group — your browser may be blocking popups. Use the group link above.");
    }
  }

  function run(action: () => Promise<{ error: string | null }>) {
    start(async () => {
      const r = await action();
      if (r.error) {
        setError(r.error);
        return;
      }
      setError(null);
      router.refresh();
    });
  }

  return (
    <li className="space-y-2 px-3 py-3 text-sm">
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <Badge variant={draft.source === "ai" ? "info" : "muted"}>
            {draft.source === "ai" ? "AI draft" : "Manual"}
          </Badge>
          {isPosted ? <Badge variant="success">posted</Badge> : null}
        </div>
      </div>

      {editing ? (
        <Textarea rows={5} value={text} maxLength={8000} onChange={(e) => setText(e.target.value)} />
      ) : (
        <p className="whitespace-pre-wrap">{draft.text}</p>
      )}

      {isPosted ? (
        <p className="text-xs text-muted-foreground">
          Marked posted{draft.posted_at ? ` · ${new Date(draft.posted_at).toLocaleDateString()}` : ""}.
        </p>
      ) : editing ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={pending || text.trim().length === 0}
            onClick={() =>
              run(async () => {
                const r = await updateDraftTextAction(draft.id, text);
                if (!r.error) setEditing(false);
                return r;
              })
            }
          >
            Save
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setText(draft.text);
              setEditing(false);
            }}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={pending} onClick={copyAndOpen}>
            {copied ? "Copied ✓ — opening…" : `Copy & open ${groupName} ↗`}
          </Button>
          {/* "Mark posted" is the honest self-report — emphasised once the
              operator has actually opened the group. */}
          <Button
            size="sm"
            variant={opened ? "secondary" : "outline"}
            disabled={pending}
            onClick={() => run(() => markDraftPostedAction(draft.id))}
            title="You posted this in the group — log it so it leaves your to-post list."
          >
            Mark posted
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => run(() => dismissDraftAction(draft.id))}
          >
            Dismiss
          </Button>
        </div>
      )}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </li>
  );
}

export function GroupCard({
  group,
  hasBrief,
  onEdit,
}: {
  group: GroupView;
  hasBrief: boolean;
  onEdit: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [manualText, setManualText] = useState("");

  const activeDrafts = group.drafts.filter((d) => d.status === "draft");
  const postedDrafts = group.drafts.filter((d) => d.status === "posted");

  function generate() {
    setError(null);
    setNotice(null);
    start(async () => {
      const r = await generateGroupDraftsAction(group.id, 3);
      if (r.error) {
        setError(r.error);
        return;
      }
      setNotice(`Generated ${r.created} draft${r.created === 1 ? "" : "s"}.`);
      router.refresh();
    });
  }

  function saveManual() {
    setError(null);
    start(async () => {
      const r = await createManualDraftAction(group.id, manualText);
      if (r.error) {
        setError(r.error);
        return;
      }
      setManualText("");
      setComposing(false);
      router.refresh();
    });
  }

  function removeGroup() {
    if (!confirm(`Remove "${group.name}"? Its drafts will be deleted too.`)) return;
    start(async () => {
      const r = await deleteGroupAction(group.id);
      if (r.error) setError(r.error);
      else router.refresh();
    });
  }

  return (
    <li id={`group-${group.id}`} className="scroll-mt-20 space-y-4 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold">{group.name}</h3>
            <Badge variant="muted">{PROMO_LABEL(group.promo_policy)}</Badge>
            {!group.allow_links ? <Badge variant="warning">No links</Badge> : null}
          </div>
          <a
            href={group.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {group.url} ↗
          </a>
          {group.member_count ? (
            <p className="text-xs text-muted-foreground tabular-nums">
              {group.member_count.toLocaleString()} members
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={onEdit} disabled={pending}>
            Edit rules
          </Button>
          <Button size="sm" variant="ghost" onClick={removeGroup} disabled={pending}>
            Remove
          </Button>
        </div>
      </div>

      <VerdictBanner verdict={group.verdict} />

      <RecommendedSchedule group={group} />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={pending}
          onClick={generate}
          title={
            hasBrief
              ? "Draft 3 posts from your brand voice + this group's rules"
              : "Add a business brief first so AI drafts sound like you"
          }
        >
          {pending ? "Working…" : "Generate with AI"}
        </Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => setComposing((c) => !c)}>
          {composing ? "Cancel" : "Write your own"}
        </Button>
        {notice ? <span className="text-xs text-emerald-600 dark:text-emerald-400">{notice}</span> : null}
        {error ? <span className="text-xs text-destructive">{error}</span> : null}
      </div>

      {composing ? (
        <div className="space-y-2 rounded-md border bg-muted/30 p-3">
          <Textarea
            rows={4}
            value={manualText}
            maxLength={8000}
            placeholder={`Write a post for ${group.name}…`}
            onChange={(e) => setManualText(e.target.value)}
          />
          <Button size="sm" disabled={pending || manualText.trim().length === 0} onClick={saveManual}>
            Save draft
          </Button>
        </div>
      ) : null}

      {activeDrafts.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">
            To post ({activeDrafts.length})
          </p>
          <ul className="divide-y rounded-md border bg-background">
            {activeDrafts.map((d) => (
              <DraftRow key={d.id} draft={d} groupUrl={group.url} groupName={group.name} />
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          No drafts yet — generate a few or write your own above.
        </p>
      )}

      {postedDrafts.length > 0 ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            Recently posted ({postedDrafts.length})
          </summary>
          <ul className="mt-1.5 divide-y rounded-md border bg-background">
            {postedDrafts.slice(0, 5).map((d) => (
              <DraftRow key={d.id} draft={d} groupUrl={group.url} groupName={group.name} />
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );
}
