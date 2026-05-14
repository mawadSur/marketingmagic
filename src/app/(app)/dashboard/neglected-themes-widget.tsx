"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { regenerateThemeAction } from "./actions";
import {
  snoozeThemeAction,
  archiveThemeAction,
} from "@/app/(app)/settings/brief/theme-snooze-actions";

// Phase 6.9 — Neglected Themes widget.
//
// Client-side wrapper around server actions: parent (server) page hands in
// the pre-computed `themes` array. Empty array = the parent should skip
// rendering — but we render a graceful "all clear" if forced. Each row
// has three affordances: regenerate (2-3 posts in that theme), snooze
// 30 days, archive permanently.

export interface NeglectedThemeRow {
  theme: string;
  engagement_rate_30d: number;
  posts_in_window: number;
  last_posted_at: string;
  days_since_last_post: number;
  rank_percentile: number;
}

type RowState = "idle" | "regenerating" | "snoozing" | "archiving" | "done" | "error";

interface RowFlash {
  state: RowState;
  message?: string;
  planId?: string;
}

export function NeglectedThemesWidget({ themes }: { themes: NeglectedThemeRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [flashes, setFlashes] = useState<Record<string, RowFlash>>({});
  const [hidden, setHidden] = useState<Record<string, boolean>>({});

  if (themes.length === 0) return null; // parent decides when to mount

  const visibleThemes = themes.filter((t) => !hidden[t.theme]);
  if (visibleThemes.length === 0) return null;

  function setFlash(theme: string, flash: RowFlash) {
    setFlashes((prev) => ({ ...prev, [theme]: flash }));
  }

  function handleRegen(theme: string) {
    setFlash(theme, { state: "regenerating" });
    startTransition(async () => {
      const result = await regenerateThemeAction(theme, 3);
      if (result.error) {
        setFlash(theme, { state: "error", message: result.error });
        return;
      }
      setFlash(theme, {
        state: "done",
        message: `Generated ${result.postsCreated} draft${result.postsCreated === 1 ? "" : "s"}. Find them in the queue.`,
        planId: result.planId ?? undefined,
      });
      router.refresh();
    });
  }

  function handleSnooze(theme: string) {
    setFlash(theme, { state: "snoozing" });
    startTransition(async () => {
      const result = await snoozeThemeAction(theme, 30);
      if (result.error) {
        setFlash(theme, { state: "error", message: result.error });
        return;
      }
      setHidden((prev) => ({ ...prev, [theme]: true }));
      router.refresh();
    });
  }

  function handleArchive(theme: string) {
    setFlash(theme, { state: "archiving" });
    startTransition(async () => {
      const result = await archiveThemeAction(theme);
      if (result.error) {
        setFlash(theme, { state: "error", message: result.error });
        return;
      }
      setHidden((prev) => ({ ...prev, [theme]: true }));
      router.refresh();
    });
  }

  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="label-eyebrow">Neglected themes</p>
          <h2 className="text-base font-medium">Winners going quiet</h2>
        </div>
        <Link
          href="/settings/brief"
          className="text-xs text-muted-foreground transition-colors duration-200 hover:text-foreground"
        >
          Manage themes →
        </Link>
      </div>
      <p className="text-xs text-muted-foreground">
        Top-quartile themes you haven&apos;t posted to in {">"} 14 days. Regenerate, snooze, or archive.
      </p>
      <ul className="divide-y rounded-lg border bg-card">
        {visibleThemes.map((t) => {
          const flash = flashes[t.theme];
          const isBusy =
            pending &&
            (flash?.state === "regenerating" ||
              flash?.state === "snoozing" ||
              flash?.state === "archiving");
          return (
            <li
              key={t.theme}
              className="flex flex-col gap-3 px-4 py-3.5 text-sm transition-colors duration-200 hover:bg-muted/30 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">#{t.theme}</span>
                  <Badge variant="info" title={`Top ${Math.round((1 - t.rank_percentile) * 100 + 1)}% by engagement`}>
                    top {Math.max(1, Math.round((1 - t.rank_percentile) * 100))}%
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {(t.engagement_rate_30d * 100).toFixed(2)}% engagement · {t.posts_in_window} post
                  {t.posts_in_window === 1 ? "" : "s"} · last posted {t.days_since_last_post}d ago
                </p>
                {flash?.message ? (
                  <p
                    className={
                      "text-xs " +
                      (flash.state === "error"
                        ? "text-destructive"
                        : "text-emerald-600 dark:text-emerald-400")
                    }
                  >
                    {flash.message}
                    {flash.state === "done" && flash.planId ? (
                      <>
                        {" "}
                        <Link className="underline" href={`/queue`}>
                          Open queue
                        </Link>
                      </>
                    ) : null}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleRegen(t.theme)}
                  disabled={isBusy}
                  className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-opacity duration-200 hover:opacity-90 disabled:opacity-50"
                >
                  {flash?.state === "regenerating" ? "Generating…" : "Regenerate 2-3"}
                </button>
                <button
                  type="button"
                  onClick={() => handleSnooze(t.theme)}
                  disabled={isBusy}
                  className="h-8 rounded-md border bg-background px-3 text-xs font-medium transition-colors duration-200 hover:bg-muted disabled:opacity-50"
                  title="Hide this theme from gap-detection for 30 days"
                >
                  Snooze 30d
                </button>
                <button
                  type="button"
                  onClick={() => handleArchive(t.theme)}
                  disabled={isBusy}
                  className="h-8 rounded-md border bg-background px-3 text-xs font-medium text-muted-foreground transition-colors duration-200 hover:bg-muted disabled:opacity-50"
                  title="Permanently hide this theme from gap-detection"
                >
                  Archive
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
