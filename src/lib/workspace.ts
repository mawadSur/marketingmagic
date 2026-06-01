import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { supabaseServer } from "@/lib/supabase/server";
import type { Database } from "@/lib/db/types";

export const ACTIVE_WS_COOKIE = "mm_active_ws";

type Workspace = Database["public"]["Tables"]["workspaces"]["Row"];
type Organization = Database["public"]["Tables"]["organizations"]["Row"];

export async function listWorkspaces(): Promise<Workspace[]> {
  const supabase = await supabaseServer();
  const { data } = await supabase
    .from("workspaces")
    .select("*")
    .order("created_at", { ascending: true });
  return data ?? [];
}

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

export async function getAuthedUserOrRedirect(redirectTo = "/login"): Promise<User> {
  const supabase = await supabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(redirectTo);
  return user;
}

export async function getActiveWorkspaceOrRedirect(): Promise<Workspace> {
  await getAuthedUserOrRedirect();
  const workspaces = await listWorkspaces();
  if (workspaces.length === 0) redirect("/onboarding/workspace");

  const cookieStore = await cookies();
  const slug = cookieStore.get(ACTIVE_WS_COOKIE)?.value;
  const active = (slug && workspaces.find((w) => w.slug === slug)) || workspaces[0]!;
  return active;
}

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
