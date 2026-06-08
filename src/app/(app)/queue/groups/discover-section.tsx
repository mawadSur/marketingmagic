"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Sparkles,
  ExternalLink,
  Bookmark,
  Check,
  X as XIcon,
  Users,
  Compass,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { DiscoveredGroupStatus } from "@/lib/db/types";
import {
  discoverGroupsAction,
  updateDiscoveredGroupStatusAction,
} from "./actions";

// "Discover groups to grow in" — the step BEFORE drafting.
//
// Meta removed the Groups API (2024-04-22), so we can't search/join groups for
// the user. Instead we ask Claude for relevant group ARCHETYPES from their
// brand brief and hand each one an outbound Facebook group-SEARCH link. The
// user clicks "Find & apply on Facebook" to do the finding + (manual) join.
// These are AI SUGGESTIONS, framed honestly — not API-verified groups.

export interface DiscoveredGroupView {
  id: string;
  name: string;
  description: string;
  why_relevant: string;
  approx_members: number | null;
  topic: string;
  facebook_search_url: string;
  suggested_search_query: string;
  status: DiscoveredGroupStatus;
}

// Triage statuses we surface a chip for. 'suggested' is the neutral default
// (no chip). 'dismissed' rows are filtered out of the active shortlist.
const STATUS_BADGE: Partial<
  Record<DiscoveredGroupStatus, { label: string; variant: "info" | "success" | "muted" }>
> = {
  saved: { label: "Saved", variant: "info" },
  applied: { label: "Applied", variant: "muted" },
  joined: { label: "Joined", variant: "success" },
};

function DiscoveredCard({ group }: { group: DiscoveredGroupView }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const isJoined = group.status === "joined";
  const isSaved = group.status === "saved";
  const badge = STATUS_BADGE[group.status];

  function setStatus(status: DiscoveredGroupStatus) {
    setError(null);
    start(async () => {
      const r = await updateDiscoveredGroupStatusAction(group.id, status);
      if (r.error) setError(r.error);
      else router.refresh();
    });
  }

  return (
    <li className="space-y-3 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold">{group.name}</h3>
            {group.topic ? <Badge variant="muted">{group.topic}</Badge> : null}
            {badge ? <Badge variant={badge.variant}>{badge.label}</Badge> : null}
          </div>
          {group.description ? (
            <p className="text-sm text-muted-foreground">{group.description}</p>
          ) : null}
          {group.approx_members ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
              <Users aria-hidden className="h-3.5 w-3.5" />
              ~{group.approx_members.toLocaleString()} members (estimate)
            </p>
          ) : null}
        </div>
      </div>

      {group.why_relevant ? (
        <p className="rounded-md border border-sky-500/20 bg-sky-500/5 p-3 text-sm">
          <span className="font-medium">Why this fits you: </span>
          <span className="text-muted-foreground">{group.why_relevant}</span>
        </p>
      ) : null}

      <p className="text-xs text-muted-foreground">
        Search Facebook for:{" "}
        <span className="font-medium text-foreground">
          &ldquo;{group.suggested_search_query}&rdquo;
        </span>
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {/* Primary outbound action: open Facebook's group search in a new tab so
            the operator finds the real group(s) and applies/joins by hand. */}
        <Button asChild size="sm">
          <a
            href={group.facebook_search_url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Find and apply to "${group.name}" groups on Facebook (opens in a new tab)`}
          >
            <ExternalLink aria-hidden className="mr-1.5 h-4 w-4" />
            Find &amp; apply on Facebook
          </a>
        </Button>

        {/* Triage controls. Save keeps it on the shortlist; Mark joined is the
            honest self-report (we can't confirm via any API); Dismiss hides it. */}
        {!isSaved && !isJoined ? (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => setStatus("saved")}
          >
            <Bookmark aria-hidden className="mr-1.5 h-4 w-4" />
            Save
          </Button>
        ) : null}

        {!isJoined ? (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => setStatus("joined")}
            title="You were accepted into a group like this — log it for your records."
          >
            <Check aria-hidden className="mr-1.5 h-4 w-4" />
            Mark joined
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => setStatus("saved")}
          >
            Undo joined
          </Button>
        )}

        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => setStatus("dismissed")}
          aria-label={`Dismiss the suggestion "${group.name}"`}
        >
          <XIcon aria-hidden className="mr-1.5 h-4 w-4" />
          Dismiss
        </Button>

        {error ? <span className="text-xs text-destructive">{error}</span> : null}
      </div>
    </li>
  );
}

export function DiscoverSection({
  discovered,
  hasBrief,
}: {
  discovered: DiscoveredGroupView[];
  hasBrief: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Active shortlist = everything the operator hasn't dismissed.
  const active = discovered.filter((d) => d.status !== "dismissed");

  function discover() {
    setError(null);
    setNotice(null);
    start(async () => {
      const r = await discoverGroupsAction(6);
      if (r.error) {
        setError(r.error);
        return;
      }
      setNotice(
        r.created > 0
          ? `Found ${r.created} new group ${r.created === 1 ? "idea" : "ideas"}.`
          : "No new ideas this time.",
      );
      router.refresh();
    });
  }

  return (
    <section className="space-y-4" aria-label="Discover groups to grow in">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Compass aria-hidden className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-medium">Discover groups to grow in</h2>
          {active.length > 0 ? (
            <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-md border bg-muted/40 px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground">
              {active.length}
            </span>
          ) : null}
        </div>
        <Button
          size="sm"
          disabled={pending}
          onClick={discover}
          title={
            hasBrief
              ? "Find Facebook Groups that fit your product, from your brand brief"
              : "Add a business brief first so we can find relevant groups"
          }
        >
          <Sparkles aria-hidden className="mr-1.5 h-4 w-4" />
          {pending ? "Finding…" : active.length > 0 ? "Find more" : "Discover groups"}
        </Button>
      </div>

      <p className="max-w-2xl text-sm text-muted-foreground">
        AI suggestions for Facebook Groups where your audience gathers. Facebook doesn&apos;t let
        apps search or join groups, so these are ideas plus a search link — you find the real group
        and request to join in one tap.
      </p>

      {notice ? (
        <p className="text-xs text-emerald-600 dark:text-emerald-400">{notice}</p>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      {active.length === 0 ? (
        <div className="rounded-lg border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
          {hasBrief ? (
            <p>
              No suggestions yet. Tap <span className="font-medium text-foreground">Discover groups</span> to
              get a shortlist of Facebook Groups worth joining to grow.
            </p>
          ) : (
            <p>
              Add your business info first so we can suggest groups that actually fit your product.
            </p>
          )}
        </div>
      ) : (
        <ul className="space-y-4">
          {active.map((g) => (
            <DiscoveredCard key={g.id} group={g} />
          ))}
        </ul>
      )}
    </section>
  );
}
