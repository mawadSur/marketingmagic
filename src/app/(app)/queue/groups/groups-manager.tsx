"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { PostingVerdict } from "@/lib/groups/posting-rules";
import type { RecommendedSlot } from "@/lib/groups/schedule";
import type {
  FacebookGroupPromoPolicy,
  FacebookGroupDraftSource,
  FacebookGroupDraftStatus,
} from "@/lib/db/types";
import { GroupCard } from "./group-card";
import { createGroupAction, updateGroupAction, type GroupInput } from "./actions";

export interface GroupDraftView {
  id: string;
  text: string;
  source: FacebookGroupDraftSource;
  status: FacebookGroupDraftStatus;
  posted_at: string | null;
  created_at: string;
}

export interface GroupView {
  id: string;
  name: string;
  url: string;
  member_count: number | null;
  promo_policy: FacebookGroupPromoPolicy;
  promo_weekdays: number[];
  allow_links: boolean;
  rules_notes: string;
  verdict: PostingVerdict;
  // Recommended posting schedule (computed server-side in the audience tz).
  // `recommendedSlot` is the soonest slot; `upcomingSlots` is a short list for
  // the card; `allowedToday` gates the "Good to post today" panel.
  recommendedSlot: RecommendedSlot;
  upcomingSlots: RecommendedSlot[];
  allowedToday: boolean;
  drafts: GroupDraftView[];
}

const WEEKDAYS: Array<{ value: number; label: string }> = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 7, label: "Sun" },
];

const EMPTY_FORM: GroupInput = {
  name: "",
  url: "",
  member_count: null,
  promo_policy: "open",
  promo_weekdays: [],
  allow_links: true,
  rules_notes: "",
};

// Add/edit form for a group's identity + posting rules. The rules here drive
// the heads-up banner (posting-rules.ts) and steer the AI generator.
function GroupForm({
  initial,
  groupId,
  onDone,
  onCancel,
}: {
  initial: GroupInput;
  groupId: string | null; // null = create
  onDone: () => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [form, setForm] = useState<GroupInput>(initial);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof GroupInput>(key: K, value: GroupInput[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function toggleWeekday(day: number) {
    const cur = form.promo_weekdays ?? [];
    set(
      "promo_weekdays",
      cur.includes(day) ? cur.filter((d) => d !== day) : [...cur, day].sort((a, b) => a - b),
    );
  }

  function submit() {
    setError(null);
    start(async () => {
      const r = groupId
        ? await updateGroupAction(groupId, form)
        : await createGroupAction(form);
      if (r.error) {
        setError(r.error);
        return;
      }
      onDone();
      router.refresh();
    });
  }

  const isLimited = form.promo_policy === "limited";

  return (
    <div className="space-y-4 rounded-lg border bg-card p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="g-name">Group name</Label>
          <Input
            id="g-name"
            value={form.name}
            maxLength={120}
            placeholder="SaaS Founders"
            onChange={(e) => set("name", e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="g-url">Group URL</Label>
          <Input
            id="g-url"
            value={form.url}
            placeholder="https://www.facebook.com/groups/…"
            onChange={(e) => set("url", e.target.value)}
          />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="g-policy">Promotion policy</Label>
          <select
            id="g-policy"
            value={form.promo_policy}
            onChange={(e) => set("promo_policy", e.target.value as FacebookGroupPromoPolicy)}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <option value="open">Promo allowed any day</option>
            <option value="limited">Promo only on certain days</option>
            <option value="value_only">No promo — value posts only</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="g-members">Members (optional)</Label>
          <Input
            id="g-members"
            type="number"
            min={0}
            value={form.member_count ?? ""}
            placeholder="e.g. 12000"
            onChange={(e) =>
              set("member_count", e.target.value === "" ? null : Number(e.target.value))
            }
          />
        </div>
      </div>

      {isLimited ? (
        <div className="space-y-1.5">
          <Label>Days promo is allowed</Label>
          <div className="flex flex-wrap gap-1.5">
            {WEEKDAYS.map((d) => {
              const on = (form.promo_weekdays ?? []).includes(d.value);
              return (
                <button
                  key={d.value}
                  type="button"
                  onClick={() => toggleWeekday(d.value)}
                  className={
                    "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors " +
                    (on
                      ? "border-foreground bg-foreground text-background"
                      : "border-input bg-background text-muted-foreground hover:text-foreground")
                  }
                  aria-pressed={on}
                >
                  {d.label}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={form.allow_links}
          onChange={(e) => set("allow_links", e.target.checked)}
          className="h-4 w-4"
        />
        This group allows links in posts
      </label>

      <div className="space-y-1.5">
        <Label htmlFor="g-rules">Group rules (paste the group&apos;s pinned rules)</Label>
        <Textarea
          id="g-rules"
          rows={4}
          value={form.rules_notes}
          maxLength={2000}
          placeholder="e.g. Self-promo only on Fridays. No external links in posts. Be helpful first."
          onChange={(e) => set("rules_notes", e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          We use these to warn you before you post and to steer AI drafts so they fit the group.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={pending || form.name.trim().length === 0 || form.url.trim().length === 0}
          onClick={submit}
        >
          {pending ? "Saving…" : groupId ? "Save changes" : "Add group"}
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        {error ? <span className="text-xs text-destructive">{error}</span> : null}
      </div>
    </div>
  );
}

export function GroupsManager({
  groups,
  hasBrief,
  timezone,
}: {
  groups: GroupView[];
  hasBrief: boolean;
  timezone: string;
}) {
  // null = no form open; "new" = create form; otherwise the group id being edited.
  const [formFor, setFormFor] = useState<string | "new" | null>(null);

  const editing = typeof formFor === "string" && formFor !== "new"
    ? groups.find((g) => g.id === formFor) ?? null
    : null;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-medium">
          Your groups
          {groups.length > 0 ? (
            <span className="ml-2 text-xs text-muted-foreground tabular-nums">{groups.length}</span>
          ) : null}
        </h2>
        {formFor === null ? (
          <Button size="sm" onClick={() => setFormFor("new")}>
            Add a group
          </Button>
        ) : null}
      </div>

      {timezone && timezone !== "UTC" ? (
        <p className="text-xs text-muted-foreground">
          Timing heads-ups use your audience timezone ({timezone}).
        </p>
      ) : null}

      {formFor === "new" ? (
        <GroupForm
          initial={EMPTY_FORM}
          groupId={null}
          onDone={() => setFormFor(null)}
          onCancel={() => setFormFor(null)}
        />
      ) : null}

      {editing ? (
        <GroupForm
          initial={{
            name: editing.name,
            url: editing.url,
            member_count: editing.member_count,
            promo_policy: editing.promo_policy,
            promo_weekdays: editing.promo_weekdays,
            allow_links: editing.allow_links,
            rules_notes: editing.rules_notes,
          }}
          groupId={editing.id}
          onDone={() => setFormFor(null)}
          onCancel={() => setFormFor(null)}
        />
      ) : null}

      {groups.length > 0 ? (
        <ul className="space-y-4">
          {groups.map((g) => (
            <GroupCard
              key={g.id}
              group={g}
              hasBrief={hasBrief}
              onEdit={() => setFormFor(g.id)}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
