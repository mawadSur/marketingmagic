import Link from "next/link";
import { getEngagementDebt } from "@/lib/interactions/queries";

// Phase 4.5 — Engagement debt widget.
//
// Lightweight banner on the dashboard. Shows a count of unanswered
// interactions plus the count older than 24h. Hidden entirely when
// both are zero — we'd rather show nothing than a "you're caught up!"
// because the dashboard already has plenty of widgets.

export async function EngagementDebtWidget({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const debt = await getEngagementDebt(workspaceId);
  if (debt.unanswered === 0) return null;

  return (
    <Link
      href="/inbox"
      className="flex items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm transition-colors hover:bg-amber-500/10"
    >
      <div className="space-y-0.5">
        <p className="font-medium text-amber-800 dark:text-amber-300">
          {debt.unanswered} unanswered
          {debt.over24h > 0 ? `, ${debt.over24h} over 24h` : ""}
        </p>
        <p className="text-xs text-amber-700/80 dark:text-amber-300/70">
          Open the inbox to triage. Drafts are voice-aware — sending requires your click.
        </p>
      </div>
      <span className="text-xs text-amber-700 dark:text-amber-300">Inbox →</span>
    </Link>
  );
}
