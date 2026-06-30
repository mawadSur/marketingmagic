"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { approveAllPendingAction, regenerateStalePendingAction } from "./actions";

// ─────────────────────────────────────────────────────────────────────────────
// Pending-section bulk actions
// ─────────────────────────────────────────────────────────────────────────────
//
// ApproveAllButton        — green-lights every pending draft in the workspace.
// RegenerateStaleBanner   — appears when the brand brief/voice changed since
//                           some pending drafts were generated, and rewrites
//                           those drafts in place to match the current brief.
//
// Both are thin client wrappers over the server actions in ./actions.ts; the
// queue page (server) computes the counts and passes them in. Each wraps its
// action in try/catch so an infra failure (e.g. a function timeout) surfaces a
// message instead of leaving the spinner stuck.

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

const GENERIC_ERROR = "Something went wrong — please try again.";

export function ApproveAllButton({ pendingCount }: { pendingCount: number }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Stay mounted after a refresh drops pendingCount to 0 so the confirmation
  // (or error) is actually seen; only the button itself hides when nothing is
  // left to approve.
  if (pendingCount === 0 && !notice && !error) return null;

  function approveAll() {
    start(async () => {
      try {
        const r = await approveAllPendingAction();
        if (r.error) {
          setError(r.error);
          setNotice(null);
          return;
        }
        setError(null);
        setNotice(
          r.approved > 0
            ? `Approved ${r.approved} ${plural(r.approved, "draft")}.`
            : "Nothing left to approve.",
        );
        router.refresh();
      } catch {
        setError(GENERIC_ERROR);
        setNotice(null);
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      {pendingCount > 0 ? (
        <Button size="sm" disabled={busy} onClick={approveAll}>
          {busy ? "Approving…" : `Approve all (${pendingCount})`}
        </Button>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {notice ? <p className="text-xs text-muted-foreground">{notice}</p> : null}
    </div>
  );
}

export function RegenerateStaleBanner({ staleCount }: { staleCount: number }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Show while there's stale work OR a just-finished summary/error to report.
  // Once staleCount hits 0 and there's nothing to report, unmount.
  if (staleCount === 0 && !result && !error) return null;

  const done = staleCount === 0 && !error;

  function regenerate() {
    start(async () => {
      try {
        const r = await regenerateStalePendingAction();
        if (r.error) {
          setError(r.error);
          setResult(null);
          router.refresh();
          return;
        }
        // All attempts failed → an error, not a quiet success.
        if (r.regenerated === 0 && r.failed > 0) {
          setError(
            `Couldn't rewrite ${r.failed === staleCount ? "the" : `${r.failed}`} ${plural(
              r.failed,
              "draft",
            )} — try again.`,
          );
          setResult(null);
          router.refresh();
          return;
        }
        setError(null);
        const parts = [`Regenerated ${r.regenerated} ${plural(r.regenerated, "draft")}`];
        if (r.failed > 0) parts.push(`${r.failed} couldn't be rewritten`);
        if (r.remaining > 0) parts.push(`${r.remaining} more queued`);
        const tail = r.failed > 0 || r.remaining > 0 ? " Click Regenerate to continue." : ".";
        setResult(parts.join(" · ") + (parts.length > 1 ? tail : "."));
        router.refresh();
      } catch {
        setError(GENERIC_ERROR);
        setResult(null);
      }
    });
  }

  return (
    <Notice
      variant={done ? "success" : "warning"}
      title={
        <span className="flex items-center gap-2">
          <RefreshCw className="h-4 w-4 shrink-0" aria-hidden />
          {done ? "Drafts refreshed" : "Your brand brief or voice changed"}
        </span>
      }
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p>
          {staleCount > 0 ? (
            <>
              {staleCount} pending {plural(staleCount, "draft")}{" "}
              {staleCount === 1 ? "was" : "were"} written against an older version of your
              brief. Regenerate {staleCount === 1 ? "it" : "them"} to match — channel, theme,
              and schedule stay the same.
            </>
          ) : (
            "Your pending drafts now match your current brief."
          )}
        </p>
        {staleCount > 0 ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={regenerate}
            className="shrink-0"
          >
            {busy ? "Regenerating…" : `Regenerate ${staleCount} ${plural(staleCount, "draft")}`}
          </Button>
        ) : null}
      </div>
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
      {result ? <p className="mt-2 text-xs text-muted-foreground">{result}</p> : null}
    </Notice>
  );
}
