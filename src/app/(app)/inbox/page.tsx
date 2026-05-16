import Link from "next/link";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { getInboxInteractions } from "@/lib/interactions/queries";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge, ChannelBadge } from "@/components/ui/badge";
import {
  bandForScore,
  interactionAgeFilterSchema,
  interactionChannelSchema,
  interactionPrioritySchema,
  interactionStatusSchema,
  type InteractionAgeFilter,
  type InteractionChannel,
  type InteractionPriority,
  type InteractionStatus,
} from "@/lib/interactions/schema";
import { InboxKeyboard } from "./inbox-keyboard";

export const dynamic = "force-dynamic";

// Filter chip-options. Kept as plain arrays so the JSX stays close to
// the HTML produced. Channel / status pull labels from a tiny mapper.
const CHANNEL_FILTERS: Array<{ value: InteractionChannel; label: string }> = [
  { value: "x", label: "X" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "bluesky", label: "Bluesky" },
  { value: "instagram", label: "Instagram" },
  { value: "threads", label: "Threads" },
];
const PRIORITY_FILTERS: Array<{ value: InteractionPriority; label: string }> = [
  { value: "high", label: "High" },
  { value: "medium", label: "Med" },
  { value: "low", label: "Low" },
];
const AGE_FILTERS: Array<{ value: InteractionAgeFilter; label: string }> = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "all", label: "All" },
];
const STATUS_FILTERS: Array<{ value: InteractionStatus; label: string }> = [
  { value: "unread", label: "Unread" },
  { value: "read", label: "Read" },
  { value: "replied", label: "Replied" },
  { value: "snoozed", label: "Snoozed" },
  { value: "dismissed", label: "Dismissed" },
];

function parseFilter<T extends string>(
  schema: { safeParse: (v: unknown) => { success: boolean; data?: T } },
  raw: string | string[] | undefined,
): T | null {
  if (typeof raw !== "string") return null;
  const r = schema.safeParse(raw);
  if (r.success && r.data) return r.data;
  return null;
}

interface SearchParams {
  channel?: string;
  priority?: string;
  age?: string;
  status?: string;
}

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ws = await getActiveWorkspaceOrRedirect();
  const sp = await searchParams;

  const channel = parseFilter<InteractionChannel>(interactionChannelSchema, sp.channel);
  const priority = parseFilter<InteractionPriority>(interactionPrioritySchema, sp.priority);
  const age = parseFilter<InteractionAgeFilter>(interactionAgeFilterSchema, sp.age);
  const status = parseFilter<InteractionStatus>(interactionStatusSchema, sp.status);

  const interactions = await getInboxInteractions({
    workspaceId: ws.id,
    channel,
    priority,
    age,
    status,
    limit: 50,
  });

  const interactionIds = interactions.map((i) => i.id);
  const hasMetaAccounts = interactions.some(
    (i) => i.channel === "instagram" || i.channel === "threads",
  );

  return (
    <div className="space-y-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <p className="label-eyebrow">Engagement</p>
          <h1 className="text-3xl font-semibold tracking-tight">Inbox</h1>
          <p className="text-sm text-muted-foreground">
            Replies and mentions across your channels. Draft a response, never auto-send.
          </p>
        </div>
        <div className="text-xs text-muted-foreground">
          <kbd className="rounded border px-1.5 py-0.5 font-mono">j</kbd>
          <kbd className="ml-1 rounded border px-1.5 py-0.5 font-mono">k</kbd>{" "}
          navigate ·{" "}
          <kbd className="rounded border px-1.5 py-0.5 font-mono">r</kbd> reply ·{" "}
          <kbd className="rounded border px-1.5 py-0.5 font-mono">s</kbd> snooze ·{" "}
          <kbd className="rounded border px-1.5 py-0.5 font-mono">x</kbd> dismiss
        </div>
      </header>

      <InboxKeyboard interactionIds={interactionIds} />

      <FilterBar
        currentChannel={channel}
        currentPriority={priority}
        currentAge={age}
        currentStatus={status}
      />

      {hasMetaAccounts ? (
        <p className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          Instagram and Threads reply paths are pending Meta App Review. You can read inbound items
          once the scopes land; for now the schema and cron are wired up so nothing is lost.
        </p>
      ) : null}

      {interactions.length === 0 ? (
        <EmptyState
          icon="spark"
          title="Nothing inbound yet."
          description="When replies, mentions, or comments come in on your connected channels, they'll show up here. The poller runs every 15 minutes."
        />
      ) : (
        <ul className="divide-y rounded-lg border bg-card">
          {interactions.map((i) => {
            const band = bandForScore(i.priority_score);
            const isUnread = i.status === "unread";
            return (
              <li
                key={i.id}
                data-interaction-id={i.id}
                className={
                  "group flex items-start justify-between gap-4 px-4 py-3 text-sm transition-colors " +
                  "hover:bg-muted/40 data-[focused=true]:bg-muted/60 " +
                  "data-[focused=true]:ring-2 data-[focused=true]:ring-foreground/10 data-[focused=true]:ring-inset"
                }
              >
                <Link
                  href={`/inbox/${i.id}`}
                  className="flex min-w-0 flex-1 flex-col gap-1"
                >
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <ChannelBadge channel={i.channel} />
                    <PriorityBadge band={band} score={i.priority_score} />
                    {isUnread ? <Badge variant="info">unread</Badge> : null}
                    {i.status === "replied" ? <Badge variant="success">replied</Badge> : null}
                    <span className="font-medium text-foreground">
                      @{i.author_handle}
                    </span>
                    {i.author_display_name ? (
                      <span>· {i.author_display_name}</span>
                    ) : null}
                    <span className="tabular-nums">
                      · {i.received_at.slice(0, 16).replace("T", " ")}
                    </span>
                  </div>
                  <p
                    className={
                      "line-clamp-2 text-sm " +
                      (isUnread ? "text-foreground" : "text-muted-foreground")
                    }
                  >
                    {i.body}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function PriorityBadge({
  band,
  score,
}: {
  band: InteractionPriority;
  score: number | null;
}) {
  const variant =
    band === "high" ? "danger" : band === "medium" ? "warning" : "muted";
  const label = band === "high" ? "high" : band === "medium" ? "med" : "low";
  return (
    <Badge
      variant={variant}
      title={`Priority score: ${score == null ? "n/a" : Math.round(score)}`}
    >
      {label}
    </Badge>
  );
}

// Filter chip rail. Each chip is a Link that toggles its filter on the
// current URL — server-rendering keeps state in sync without client JS.
function FilterBar({
  currentChannel,
  currentPriority,
  currentAge,
  currentStatus,
}: {
  currentChannel: InteractionChannel | null;
  currentPriority: InteractionPriority | null;
  currentAge: InteractionAgeFilter | null;
  currentStatus: InteractionStatus | null;
}) {
  return (
    <div className="space-y-2 text-xs">
      <FilterRow
        label="Channel"
        paramName="channel"
        options={CHANNEL_FILTERS}
        current={currentChannel}
        otherParams={{
          priority: currentPriority,
          age: currentAge,
          status: currentStatus,
        }}
      />
      <FilterRow
        label="Priority"
        paramName="priority"
        options={PRIORITY_FILTERS}
        current={currentPriority}
        otherParams={{
          channel: currentChannel,
          age: currentAge,
          status: currentStatus,
        }}
      />
      <FilterRow
        label="Age"
        paramName="age"
        options={AGE_FILTERS}
        current={currentAge}
        otherParams={{
          channel: currentChannel,
          priority: currentPriority,
          status: currentStatus,
        }}
      />
      <FilterRow
        label="Status"
        paramName="status"
        options={STATUS_FILTERS}
        current={currentStatus}
        otherParams={{
          channel: currentChannel,
          priority: currentPriority,
          age: currentAge,
        }}
      />
    </div>
  );
}

function FilterRow<T extends string>({
  label,
  paramName,
  options,
  current,
  otherParams,
}: {
  label: string;
  paramName: string;
  options: Array<{ value: T; label: string }>;
  current: T | null;
  otherParams: Record<string, string | null>;
}) {
  function buildUrl(value: T | null): string {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(otherParams)) {
      if (v) params.set(k, v);
    }
    if (value) params.set(paramName, value);
    const qs = params.toString();
    return qs ? `/inbox?${qs}` : "/inbox";
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 inline-flex w-20 shrink-0 items-center text-muted-foreground">
        {label}
      </span>
      <Link
        href={buildUrl(null)}
        className={
          "rounded-md border px-2 py-0.5 transition-colors " +
          (current == null
            ? "border-foreground/40 bg-foreground/5 text-foreground"
            : "text-muted-foreground hover:text-foreground")
        }
      >
        All
      </Link>
      {options.map((opt) => (
        <Link
          key={opt.value}
          href={buildUrl(opt.value)}
          className={
            "rounded-md border px-2 py-0.5 transition-colors " +
            (current === opt.value
              ? "border-foreground/40 bg-foreground/5 text-foreground"
              : "text-muted-foreground hover:text-foreground")
          }
        >
          {opt.label}
        </Link>
      ))}
    </div>
  );
}
