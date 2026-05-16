"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  acceptReplanProposalAction,
  type AcceptReplanState,
} from "./replan-actions";

// Phase 2.1 replan-loop — the banner the user lands on when they click
// "Plan is behind — propose new strategy?" from the dashboard widget.
//
// Rendered above the existing strategy preview on /goals/[id] when:
//   1. The URL carries `?replan=1`, AND
//   2. There's an unaccepted replan_proposals row for this goal.
//
// The page resolves both conditions server-side and only mounts this
// banner when they hold — the banner itself never queries; it just
// surfaces the two actions the user can take and a short copy block
// derived from the proposal reason ("Behind at week 2", etc.).
//
// Two buttons:
//   - "Propose new strategy" (primary) — runs proposeStrategy() again
//     with enriched context (actual vs target + elapsed time + posts
//     shipped/missed), inserts a NEW content_goals row with
//     parent_goal_id set, and redirects to /goals/<new_id> for two-step
//     approval.
//   - "Dismiss" (outline) — just stamps the proposal accepted_at so the
//     CTA disappears from the dashboard. The original goal stays
//     untouched.
//
// We pass two separate forms (one per mode) so each button has its own
// pending state. Sharing a single form with a hidden mode field would
// require client-side state to flip the mode before submit, which adds
// a window where the user can flip-flop. Two forms = two actions.

interface ReplanBannerProps {
  proposalId: string;
  reason: string;
}

const INITIAL: AcceptReplanState = { error: null, newGoalId: null };

export function ReplanBanner({ proposalId, reason }: ReplanBannerProps) {
  const [proposeState, proposeAction, proposePending] = useActionState(
    acceptReplanProposalAction,
    INITIAL,
  );
  const [dismissState, dismissAction, dismissPending] = useActionState(
    acceptReplanProposalAction,
    INITIAL,
  );

  const headline = headlineFromReason(reason);
  const subheading = subheadingFromReason(reason);
  const error = proposeState.error ?? dismissState.error;

  return (
    <Card className="border-amber-500/30 bg-amber-500/5">
      <CardHeader>
        <CardTitle className="text-base text-amber-700 dark:text-amber-400">
          {headline}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">{subheading}</p>
        <p className="text-xs text-muted-foreground">
          A replan keeps the original goal text and target. We&apos;ll propose a fresh
          strategy informed by what shipped, what missed, and how much runway is left —
          then drop the new plan in draft for your approval.
        </p>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <form action={proposeAction}>
            <input type="hidden" name="proposal_id" value={proposalId} />
            <input type="hidden" name="mode" value="propose_new" />
            <Button type="submit" disabled={proposePending || dismissPending}>
              {proposePending ? "Proposing (≈20s)…" : "Propose new strategy"}
            </Button>
          </form>
          <form action={dismissAction}>
            <input type="hidden" name="proposal_id" value={proposalId} />
            <input type="hidden" name="mode" value="dismiss" />
            <Button
              type="submit"
              variant="outline"
              disabled={proposePending || dismissPending}
            >
              {dismissPending ? "Dismissing…" : "Dismiss"}
            </Button>
          </form>
        </div>
        {error ? (
          <p className="text-xs text-destructive">{error}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

// Renders a human headline from the `behind_at_week_N` tag the cron
// writes. Falls back to a generic message for any other reason string —
// the schema is free-form so a future "user-initiated replan" surface
// (proposed_by='user') could write any tag.
function headlineFromReason(reason: string): string {
  const week = matchWeek(reason);
  if (week != null) {
    return `Plan is behind at week ${week} — propose a new strategy?`;
  }
  return "Plan is behind — propose a new strategy?";
}

function subheadingFromReason(reason: string): string {
  const week = matchWeek(reason);
  if (week != null) {
    return (
      `We checked progress at week ${week} and the pace slipped. ` +
      `You can either reroute around what's not working, or dismiss this and keep going with the original plan.`
    );
  }
  return "Your goal is tracking behind pace. Reroute, or keep going as-is.";
}

function matchWeek(reason: string): number | null {
  const m = reason.match(/^behind_at_week_(\d+)/);
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  return Number.isFinite(n) ? n : null;
}
