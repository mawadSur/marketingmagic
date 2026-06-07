// ─────────────────────────────────────────────────────────────
// Client self-connect — branding + connected-channel reads (migration 044)
// ─────────────────────────────────────────────────────────────
//
// SECURITY: the self-connect landing page is unauthenticated, so (like the
// portal DAL) these functions run via the SERVICE ROLE and MUST take the
// workspace ONLY from a validated SelfConnectContext — never from the request.
// Each query is scoped to that single workspaceId; no function accepts a
// workspaceId argument the caller could widen.
//
// The branding read mirrors src/lib/portal/data.ts getPortalBranding one-for-one
// (workspace → organization_id → org branding), reusing the SAME PortalBranding
// shape + resolveTheme() so the self-connect page is white-labeled identically
// to the client portal.

import { supabaseService } from "@/lib/supabase/service";
import type { PortalBranding } from "@/lib/portal/data";
import type { SelfConnectContext } from "@/lib/client-connect/token";

/**
 * White-label branding for the self-connect page, resolved via the workspace's
 * org. Same fallback rules as the portal: a solo workspace or an org with no
 * branding yields null fields (the page falls back to neutral defaults). This is
 * the ONLY place we read outside the workspace row, and it does so by first
 * reading the workspace (scoped to ctx) then following its organization_id.
 */
export async function getSelfConnectBranding(
  ctx: SelfConnectContext,
): Promise<PortalBranding> {
  const svc = supabaseService();

  // Workspace, scoped by id == ctx.workspaceId (PK equality is the scope).
  const { data: ws } = await svc
    .from("workspaces")
    .select("name, organization_id")
    .eq("id", ctx.workspaceId)
    .maybeSingle();

  if (!ws) {
    return {
      workspaceName: "Workspace",
      organizationName: null,
      logoUrl: null,
      colorPrimary: null,
      colorAccent: null,
    };
  }

  if (!ws.organization_id) {
    return {
      workspaceName: ws.name,
      organizationName: null,
      logoUrl: null,
      colorPrimary: null,
      colorAccent: null,
    };
  }

  // Organization, scoped by the organization_id read off the (ctx-scoped)
  // workspace. We never accept an org id from anywhere else.
  const { data: org } = await svc
    .from("organizations")
    .select("name, logo_url, color_primary, color_accent")
    .eq("id", ws.organization_id)
    .maybeSingle();

  return {
    workspaceName: ws.name,
    organizationName: org?.name ?? null,
    logoUrl: org?.logo_url ?? null,
    colorPrimary: org?.color_primary ?? null,
    colorAccent: org?.color_accent ?? null,
  };
}

/**
 * The set of channels already connected for the workspace, so the landing page
 * can show "✓ connected" instead of offering a duplicate connect. Scoped to
 * ctx.workspaceId; excludes disconnected rows (which read as "not connected"
 * everywhere, matching the authed channel settings page).
 */
export async function getConnectedChannels(
  ctx: SelfConnectContext,
): Promise<Set<string>> {
  const svc = supabaseService();
  const { data } = await svc
    .from("social_accounts")
    .select("channel")
    .eq("workspace_id", ctx.workspaceId)
    .neq("status", "disconnected");
  return new Set((data ?? []).map((r) => r.channel));
}
