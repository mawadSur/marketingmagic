"use client";

import { useState, useTransition } from "react";
import { Label } from "@/components/ui/label";
import {
  clearThemeMuteAction,
  setGapsEnabledAction,
  snoozeThemeAction,
  archiveThemeAction,
} from "./theme-snooze-actions";

// Phase 6.9 — settings panel for theme snooze/archive + opt-out toggle.
//
// Pre-populates with the current snooze entries (snoozed / archived) and
// shows muted themes from the brief's actually-posted themes too, so the
// user can pro-actively archive a theme they don't want surfaced before
// it even becomes neglected. The opt-out switch flips
// brand_briefs.theme_gaps_enabled and silently disables the cron + UI.

export interface SnoozeEntry {
  theme: string;
  snoozed_until: string | null;
  archived: boolean;
}

export interface ThemeSnoozeControlsProps {
  gapsEnabled: boolean;
  entries: SnoozeEntry[];
  knownThemes: string[]; // distinct theme tags this workspace has posted
}

export function ThemeSnoozeControls(props: ThemeSnoozeControlsProps) {
  const [gapsEnabled, setGapsEnabled] = useState<boolean>(props.gapsEnabled);
  const [entries, setEntries] = useState<SnoozeEntry[]>(props.entries);
  const [newTheme, setNewTheme] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const mutedSet = new Set(entries.map((e) => e.theme));
  // Themes the user has posted before but hasn't muted yet — surface them
  // so they can preemptively archive themes they don't want suggested.
  const availableThemes = props.knownThemes.filter((t) => !mutedSet.has(t.toLowerCase()));

  function withFlash(fn: () => Promise<{ error: string | null }>) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (result.error) setError(result.error);
    });
  }

  function snooze(theme: string) {
    withFlash(async () => {
      const result = await snoozeThemeAction(theme, 30);
      if (!result.error) {
        setEntries((prev) => {
          const filtered = prev.filter((e) => e.theme !== theme.toLowerCase());
          return [
            ...filtered,
            {
              theme: theme.toLowerCase(),
              snoozed_until: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
              archived: false,
            },
          ];
        });
        setNewTheme("");
      }
      return result;
    });
  }

  function archive(theme: string) {
    withFlash(async () => {
      const result = await archiveThemeAction(theme);
      if (!result.error) {
        setEntries((prev) => {
          const filtered = prev.filter((e) => e.theme !== theme.toLowerCase());
          return [
            ...filtered,
            { theme: theme.toLowerCase(), snoozed_until: null, archived: true },
          ];
        });
        setNewTheme("");
      }
      return result;
    });
  }

  function clear(theme: string) {
    withFlash(async () => {
      const result = await clearThemeMuteAction(theme);
      if (!result.error) {
        setEntries((prev) => prev.filter((e) => e.theme !== theme.toLowerCase()));
      }
      return result;
    });
  }

  function toggleGaps(next: boolean) {
    withFlash(async () => {
      const result = await setGapsEnabledAction(next);
      if (!result.error) setGapsEnabled(next);
      return result;
    });
  }

  return (
    <section className="space-y-4 rounded-lg border bg-muted/20 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label className="text-sm">Theme-gap detection</Label>
          <p className="text-xs text-muted-foreground">
            Surfaces winning themes you haven&apos;t posted to in {">"} 14 days. Disable to silence the
            dashboard widget and digest section entirely.
          </p>
        </div>
        <label className="flex shrink-0 cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={gapsEnabled}
            onChange={(e) => toggleGaps(e.target.checked)}
            disabled={pending}
            className="h-4 w-4 cursor-pointer"
          />
          <span className="text-xs text-muted-foreground">
            {gapsEnabled ? "Enabled" : "Disabled"}
          </span>
        </label>
      </div>

      {entries.length > 0 ? (
        <div className="space-y-2">
          <p className="label-eyebrow">Muted themes</p>
          <ul className="divide-y rounded-md border bg-card">
            {entries.map((e) => (
              <li
                key={e.theme}
                className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
              >
                <span className="min-w-0 space-y-0.5">
                  <span className="block truncate font-medium">#{e.theme}</span>
                  <span className="block text-[11px] text-muted-foreground">
                    {e.archived
                      ? "Archived — permanently hidden from gap-detection."
                      : `Snoozed until ${formatDate(e.snoozed_until)}.`}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => clear(e.theme)}
                  disabled={pending}
                  className="h-7 shrink-0 rounded-md border bg-background px-2 text-xs font-medium transition-colors duration-200 hover:bg-muted disabled:opacity-50"
                >
                  {e.archived ? "Unarchive" : "Wake up"}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="space-y-2">
        <p className="label-eyebrow">Add a theme to mute</p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {availableThemes.length > 0 ? (
            <select
              value={newTheme}
              onChange={(e) => setNewTheme(e.target.value)}
              disabled={pending}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm transition-colors duration-200 sm:max-w-xs"
            >
              <option value="">Pick a theme…</option>
              {availableThemes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={newTheme}
              onChange={(e) => setNewTheme(e.target.value)}
              placeholder="theme-tag"
              disabled={pending}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm transition-colors duration-200 sm:max-w-xs"
            />
          )}
          <button
            type="button"
            onClick={() => newTheme && snooze(newTheme)}
            disabled={pending || !newTheme}
            className="h-9 shrink-0 rounded-md border bg-background px-3 text-xs font-medium transition-colors duration-200 hover:bg-muted disabled:opacity-50"
          >
            Snooze 30d
          </button>
          <button
            type="button"
            onClick={() => newTheme && archive(newTheme)}
            disabled={pending || !newTheme}
            className="h-9 shrink-0 rounded-md border bg-background px-3 text-xs font-medium text-muted-foreground transition-colors duration-200 hover:bg-muted disabled:opacity-50"
          >
            Archive
          </button>
        </div>
        {availableThemes.length === 0 && entries.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            Once you&apos;ve posted a few themes, they&apos;ll appear here for muting.
          </p>
        ) : null}
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </section>
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}
