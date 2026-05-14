// Phase 6.9 — Per-theme snooze/archive preferences.
//
// Stored on brand_briefs.theme_snooze (jsonb array; see migration 013).
// Each entry is either:
//   { theme, snoozed_until }   — hidden from gap-detection until that ISO
//   { theme, archived: true }  — hidden permanently until unarchived
//
// Helpers here normalise the array shape (deduping by theme, lower-casing
// the theme key, dropping expired snoozes), so callers can treat the
// returned set as the canonical "ignore these themes" filter.

import { supabaseService } from "@/lib/supabase/service";
import type { ThemeSnoozeEntry } from "@/lib/db/types";

export interface NormalizedSnoozeEntry {
  theme: string;
  snoozed_until: string | null;
  archived: boolean;
}

export interface ThemePreferences {
  briefId: string | null;
  gapsEnabled: boolean;
  entries: NormalizedSnoozeEntry[];
}

const SNOOZE_THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// Normalise a raw jsonb array into a deduped list of valid entries. Drops
// rows that are malformed, have empty theme names, or — for snoozes — have
// already expired by `now`. Idempotent and total: handles `null` / wrong-
// shape inputs by returning an empty array.
export function normalizeThemeSnooze(
  raw: unknown,
  now: Date = new Date(),
): NormalizedSnoozeEntry[] {
  if (!Array.isArray(raw)) return [];
  const byTheme = new Map<string, NormalizedSnoozeEntry>();
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const row = r as Record<string, unknown>;
    const theme = typeof row.theme === "string" ? row.theme.trim().toLowerCase() : "";
    if (!theme) continue;
    const archived = row.archived === true;
    const snoozedUntilRaw = typeof row.snoozed_until === "string" ? row.snoozed_until : null;
    let snoozedUntil: string | null = null;
    if (snoozedUntilRaw) {
      const d = new Date(snoozedUntilRaw);
      if (!Number.isNaN(d.getTime()) && d.getTime() > now.getTime()) {
        snoozedUntil = d.toISOString();
      }
    }
    if (!archived && !snoozedUntil) continue; // expired snooze or no signal — drop
    // Last write wins per theme; archive trumps snooze when both present.
    const existing = byTheme.get(theme);
    if (existing?.archived) continue;
    byTheme.set(theme, { theme, snoozed_until: snoozedUntil, archived });
  }
  return Array.from(byTheme.values()).sort((a, b) => a.theme.localeCompare(b.theme));
}

// Whether a theme is currently filtered out of gap-detection. Lower-cases
// for comparison so display tag "Build-Progress" and stored "build-progress"
// match. Empty/whitespace themes return false.
export function isThemeMuted(
  entries: NormalizedSnoozeEntry[],
  theme: string,
): boolean {
  const key = theme.trim().toLowerCase();
  if (!key) return false;
  return entries.some((e) => e.theme === key);
}

// Read a workspace's theme preferences. Returns sensible defaults
// (gapsEnabled=true, empty entries) when the brief row doesn't exist yet
// — the cron + UI both handle the "no brief" case as a no-op.
export async function getThemePreferences(workspaceId: string): Promise<ThemePreferences> {
  const svc = supabaseService();
  const { data, error } = await svc
    .from("brand_briefs")
    .select("id, theme_snooze, theme_gaps_enabled")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error || !data) {
    return { briefId: null, gapsEnabled: true, entries: [] };
  }
  const row = data as {
    id: string;
    theme_snooze: unknown;
    theme_gaps_enabled: boolean | null;
  };
  return {
    briefId: row.id,
    gapsEnabled: row.theme_gaps_enabled !== false,
    entries: normalizeThemeSnooze(row.theme_snooze),
  };
}

// Snooze a theme for `days` (default 30). Writes through the existing
// theme_snooze jsonb. Caller must already be authenticated and own the
// workspace — server actions wrap this with supabaseServer() so RLS gates.
export async function snoozeTheme(
  workspaceId: string,
  theme: string,
  days: number = 30,
): Promise<{ error: string | null }> {
  const trimmed = theme.trim();
  if (!trimmed) return { error: "Pick a theme to snooze." };
  const ms = Math.max(1, Math.floor(days)) * 24 * 60 * 60 * 1000;
  if (ms > SNOOZE_THIRTY_DAYS_MS * 12) {
    return { error: "Snooze must be ≤ 360 days." };
  }
  const until = new Date(Date.now() + ms).toISOString();
  return upsertEntry(workspaceId, {
    theme: trimmed.toLowerCase(),
    snoozed_until: until,
  });
}

export async function archiveTheme(
  workspaceId: string,
  theme: string,
): Promise<{ error: string | null }> {
  const trimmed = theme.trim();
  if (!trimmed) return { error: "Pick a theme to archive." };
  return upsertEntry(workspaceId, {
    theme: trimmed.toLowerCase(),
    archived: true,
  });
}

// Remove any snooze/archive entry for `theme`. Used by the "unarchive" /
// "wake up" affordance in settings.
export async function clearThemeMute(
  workspaceId: string,
  theme: string,
): Promise<{ error: string | null }> {
  const trimmed = theme.trim().toLowerCase();
  if (!trimmed) return { error: "Pick a theme to clear." };
  const svc = supabaseService();
  const { data: brief, error: readErr } = await svc
    .from("brand_briefs")
    .select("id, theme_snooze")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (readErr) return { error: readErr.message };
  if (!brief) return { error: "Save the brand brief first." };

  const current = normalizeThemeSnooze((brief as { theme_snooze: unknown }).theme_snooze);
  const next = current.filter((e) => e.theme !== trimmed);
  const { error: updErr } = await svc
    .from("brand_briefs")
    .update({ theme_snooze: next as unknown as ThemeSnoozeEntry[] })
    .eq("id", (brief as { id: string }).id);
  if (updErr) return { error: updErr.message };
  return { error: null };
}

// Flip the workspace-level opt-out toggle. Setting `enabled=false` makes
// both the cron skip the workspace and the dashboard widget hide entirely.
export async function setGapsEnabled(
  workspaceId: string,
  enabled: boolean,
): Promise<{ error: string | null }> {
  const svc = supabaseService();
  const { data: brief, error: readErr } = await svc
    .from("brand_briefs")
    .select("id")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (readErr) return { error: readErr.message };
  if (!brief) return { error: "Save the brand brief first." };
  const { error: updErr } = await svc
    .from("brand_briefs")
    .update({ theme_gaps_enabled: enabled })
    .eq("id", (brief as { id: string }).id);
  if (updErr) return { error: updErr.message };
  return { error: null };
}

async function upsertEntry(
  workspaceId: string,
  entry: ThemeSnoozeEntry,
): Promise<{ error: string | null }> {
  const svc = supabaseService();
  const { data: brief, error: readErr } = await svc
    .from("brand_briefs")
    .select("id, theme_snooze")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (readErr) return { error: readErr.message };
  if (!brief) return { error: "Save the brand brief first." };

  const current = normalizeThemeSnooze((brief as { theme_snooze: unknown }).theme_snooze);
  const filtered = current.filter((e) => e.theme !== entry.theme);
  const merged: ThemeSnoozeEntry[] = [
    ...filtered.map(toStoredEntry),
    entry,
  ];

  const { error: updErr } = await svc
    .from("brand_briefs")
    .update({ theme_snooze: merged })
    .eq("id", (brief as { id: string }).id);
  if (updErr) return { error: updErr.message };
  return { error: null };
}

function toStoredEntry(e: NormalizedSnoozeEntry): ThemeSnoozeEntry {
  if (e.archived) return { theme: e.theme, archived: true };
  return { theme: e.theme, snoozed_until: e.snoozed_until ?? new Date().toISOString() };
}
