// Per-user workspace UX preferences stored in HTTP-only cookies.
//
// Two cookies, both kept tiny:
//   * mm_workspace_pins  — comma-separated workspace UUIDs the user has
//     pinned (max 5). Pinned workspaces appear first in the cmd-K palette.
//   * mm_workspace_recents — comma-separated workspace UUIDs in recency
//     order (newest first, max 5). Bumped every time switchWorkspaceAction
//     fires so the palette can surface "where I was just looking" without
//     a DB round-trip.
//
// We use cookies (not localStorage) so server components reading the
// app layout see the same ordering on first paint — no client-side flicker.
//
// Both cookies are httpOnly so client JS can't tamper with them, and both
// have a 1-year max-age. UUIDs are validated against the user's actual
// workspace list before we ever act on them.

import { cookies } from "next/headers";

export const WORKSPACE_PINS_COOKIE = "mm_workspace_pins";
export const WORKSPACE_RECENTS_COOKIE = "mm_workspace_recents";

const MAX_PINS = 5;
const MAX_RECENTS = 5;
// 1-year persistence — matches the active-workspace cookie's TTL.
const MAX_AGE = 60 * 60 * 24 * 365;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse a comma-separated UUID list cookie. Filters out anything malformed. */
export function parseIdList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => UUID_RE.test(s));
}

export async function readPinnedIds(): Promise<string[]> {
  const jar = await cookies();
  return parseIdList(jar.get(WORKSPACE_PINS_COOKIE)?.value);
}

export async function readRecentIds(): Promise<string[]> {
  const jar = await cookies();
  return parseIdList(jar.get(WORKSPACE_RECENTS_COOKIE)?.value);
}

export async function setPinnedIds(ids: string[]): Promise<void> {
  const cleaned = ids.filter((id) => UUID_RE.test(id)).slice(0, MAX_PINS);
  const jar = await cookies();
  jar.set(WORKSPACE_PINS_COOKIE, cleaned.join(","), {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: MAX_AGE,
  });
}

export async function setRecentIds(ids: string[]): Promise<void> {
  const cleaned = ids.filter((id) => UUID_RE.test(id)).slice(0, MAX_RECENTS);
  const jar = await cookies();
  jar.set(WORKSPACE_RECENTS_COOKIE, cleaned.join(","), {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: MAX_AGE,
  });
}

/**
 * Add `id` to the front of the recents list, dedupe, and persist. Called
 * by `switchWorkspaceAction` so the cmd-K palette always shows the most
 * recently-visited workspaces first.
 */
export async function bumpRecent(id: string): Promise<void> {
  if (!UUID_RE.test(id)) return;
  const current = await readRecentIds();
  const next = [id, ...current.filter((x) => x !== id)].slice(0, MAX_RECENTS);
  await setRecentIds(next);
}

/**
 * Toggle pin state. Idempotent — re-pinning a pinned workspace removes it.
 * Returns the new pin list so callers can revalidate UI without re-reading.
 */
export async function togglePin(id: string): Promise<string[]> {
  if (!UUID_RE.test(id)) return await readPinnedIds();
  const current = await readPinnedIds();
  const isPinned = current.includes(id);
  const next = isPinned
    ? current.filter((x) => x !== id)
    : [id, ...current.filter((x) => x !== id)].slice(0, MAX_PINS);
  await setPinnedIds(next);
  return next;
}
