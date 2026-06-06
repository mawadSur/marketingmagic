import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { supabaseServer } from "@/lib/supabase/server";
import type { Database } from "@/lib/db/types";

export const ACTIVE_WS_COOKIE = "mm_active_ws";

type Workspace = Database["public"]["Tables"]["workspaces"]["Row"];
type Organization = Database["public"]["Tables"]["organizations"]["Row"];

// Memoized per request (React cache): the (app) layout and the page tree both
// read the workspace list in the same render → one Supabase round-trip, shared.
export const listWorkspaces = cache(async (): Promise<Workspace[]> => {
  const supabase = await supabaseServer();
  const { data } = await supabase
    .from("workspaces")
    .select("*")
    .order("created_at", { ascending: true });
  return data ?? [];
});

// ─── Organization / agency awareness (Phase A — migration 029) ──────────
//
// Everything below is additive. A workspace with organization_id = null
// behaves exactly as before; these helpers simply surface the org layer for
// agency staff. RLS (the extended is_workspace_member + the org-member SELECT
// policy on workspaces) already scopes every read to the caller's orgs, so
// these never need a service-role client.

// Organizations the current user can see (owned + member of). RLS on
// `organizations` (org-member SELECT) does the filtering.
export async function listOrganizations(): Promise<Organization[]> {
  const supabase = await supabaseServer();
  const { data } = await supabase
    .from("organizations")
    .select("*")
    .order("created_at", { ascending: true });
  return data ?? [];
}

// Resolve a single organization by id (or null). Returns null when the caller
// isn't a member (RLS hides the row), so callers can treat null as
// "not your org / no org".
export async function getOrganization(organizationId: string): Promise<Organization | null> {
  const supabase = await supabaseServer();
  const { data } = await supabase
    .from("organizations")
    .select("*")
    .eq("id", organizationId)
    .maybeSingle();
  return data ?? null;
}

// The org a given workspace belongs to, or null for a solo workspace. Reads
// the workspace's organization_id then resolves the org row (RLS-gated).
export async function getWorkspaceOrganization(
  workspace: Pick<Workspace, "organization_id">,
): Promise<Organization | null> {
  if (!workspace.organization_id) return null;
  return getOrganization(workspace.organization_id);
}

// Client workspaces under an organization (the agency's managed clients).
// Solo workspaces (organization_id null) are never returned here — they show
// up in listWorkspaces() as today. RLS scopes this to the caller's org.
export async function listClientWorkspaces(organizationId: string): Promise<Workspace[]> {
  const supabase = await supabaseServer();
  const { data } = await supabase
    .from("workspaces")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true });
  return data ?? [];
}

// Memoized per request (React cache): keyed on redirectTo, so the layout and
// every page share the single auth.getUser() round-trip. Redirect on no-user is
// preserved (it runs the first time and the cached value is always a real User).
export const getAuthedUserOrRedirect = cache(async (redirectTo = "/login"): Promise<User> => {
  const supabase = await supabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(redirectTo);
  return user;
});

// ─── Client ACCOUNTS (migration 037) — agency-vs-client routing ─────────
//
// A "client-only" user has NO agency footprint: zero workspaces visible via the
// owner/member path AND zero org memberships. They may still have
// client_memberships (the narrow report link) — those are NEVER wired into
// workspace RLS, so they don't show up in listWorkspaces(). This is the single
// source of truth both the auth callback (where to land) and the agency app
// shell (whether to BLOCK the client) route off.
//
// Reads go through the AUTHED (RLS-backed) client so each probe is scoped to the
// caller. We only need existence → head-count queries keep it a cheap pair.
export async function isClientOnlyUser(): Promise<boolean> {
  const supabase = await supabaseServer();
  const [{ count: wsCount }, { count: orgCount }] = await Promise.all([
    supabase.from("workspaces").select("id", { count: "exact", head: true }),
    supabase.from("org_memberships").select("user_id", { count: "exact", head: true }),
  ]);
  return (wsCount ?? 0) === 0 && (orgCount ?? 0) === 0;
}

// Does the authed user have ANY client_memberships? (RLS scopes to auth.uid().)
// Used together with isClientOnlyUser to decide if a no-agency user is a real
// client (→ /portal) versus a brand-new user with nothing yet (→ onboarding).
export async function hasClientMemberships(): Promise<boolean> {
  const supabase = await supabaseServer();
  const { count } = await supabase
    .from("client_memberships")
    .select("id", { count: "exact", head: true });
  return (count ?? 0) > 0;
}

// Agency-app GUARD. Call at the top of the (app) shell: a client (no agency
// footprint + has client memberships) is redirected to /portal and can NEVER
// load an agency page. Agency/solo users (any workspace or org membership) pass
// straight through untouched.
export async function blockClientsFromAgencyApp(): Promise<void> {
  if (await isClientOnlyUser()) {
    if (await hasClientMemberships()) redirect("/portal");
    // else: a brand-new user with neither agency footprint nor client links —
    // let the normal onboarding redirect (in getActiveWorkspaceOrRedirect) run.
  }
}

// Memoized per request (React cache): the (app) layout resolves the active
// workspace and so does the page tree — same render, one resolution. The two
// memoized reads above (user + workspaces) are deduped too, and the cookie read
// has no side effect, so redirect behavior is unchanged.
export const getActiveWorkspaceOrRedirect = cache(async (): Promise<Workspace> => {
  await getAuthedUserOrRedirect();
  const workspaces = await listWorkspaces();
  if (workspaces.length === 0) redirect("/onboarding/workspace");

  const cookieStore = await cookies();
  const slug = cookieStore.get(ACTIVE_WS_COOKIE)?.value;
  const active = (slug && workspaces.find((w) => w.slug === slug)) || workspaces[0]!;
  return active;
});

export async function setActiveWorkspaceCookie(slug: string) {
  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_WS_COOKIE, slug, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
  });
}
