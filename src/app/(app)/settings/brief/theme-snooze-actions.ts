"use server";

import { revalidatePath } from "next/cache";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import {
  snoozeTheme,
  archiveTheme,
  clearThemeMute,
  setGapsEnabled,
} from "@/lib/themes/preferences";

// Phase 6.9 — server actions for theme snooze/archive UI affordances.
//
// Shared by the dashboard "Neglected Themes" widget and the settings
// "Theme snooze controls" panel. Each action is authenticated through
// getActiveWorkspaceOrRedirect() so the user must own the workspace.

export type SnoozeActionResult = { error: string | null };

export async function snoozeThemeAction(
  theme: string,
  days: number = 30,
): Promise<SnoozeActionResult> {
  const ws = await getActiveWorkspaceOrRedirect();
  const result = await snoozeTheme(ws.id, theme, days);
  if (result.error) return result;
  revalidatePath("/dashboard");
  revalidatePath("/settings/brief");
  return { error: null };
}

export async function archiveThemeAction(theme: string): Promise<SnoozeActionResult> {
  const ws = await getActiveWorkspaceOrRedirect();
  const result = await archiveTheme(ws.id, theme);
  if (result.error) return result;
  revalidatePath("/dashboard");
  revalidatePath("/settings/brief");
  return { error: null };
}

export async function clearThemeMuteAction(theme: string): Promise<SnoozeActionResult> {
  const ws = await getActiveWorkspaceOrRedirect();
  const result = await clearThemeMute(ws.id, theme);
  if (result.error) return result;
  revalidatePath("/dashboard");
  revalidatePath("/settings/brief");
  return { error: null };
}

export async function setGapsEnabledAction(enabled: boolean): Promise<SnoozeActionResult> {
  const ws = await getActiveWorkspaceOrRedirect();
  const result = await setGapsEnabled(ws.id, enabled);
  if (result.error) return result;
  revalidatePath("/dashboard");
  revalidatePath("/settings/brief");
  return { error: null };
}
