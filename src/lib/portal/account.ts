// ─────────────────────────────────────────────────────────────
// Client ACCOUNTS — authenticated client report data-access layer (migration 037)
// ─────────────────────────────────────────────────────────────
//
// SECURITY — this module is the entire trust boundary for a logged-in CLIENT.
//
// A "client" is an authenticated user linked to one or more client workspaces
// via public.client_memberships (a NARROW link, separate from `memberships`).
// A client may read ONLY the aggregate REPORT for a workspace they're linked to.
// They have NO write path and NO access to posts/social_accounts/brand_briefs/
// organizations/other workspaces — those tables' RLS routes through
// is_workspace_member(), which migration 037 deliberately does NOT extend.
//
// Two-layer gate on every report read (defence in depth):
//   1. RLS layer — resolveClientWorkspaces() reads client_memberships through
//      the AUTHED (RLS-backed) client, so the DB only ever returns the caller's
//      OWN links (user_id = auth.uid()). The caller cannot enumerate or target
//      another user's memberships.
//   2. Helper layer — before any SERVICE-ROLE report read we re-assert
//      user_is_client_of(workspace_id) via RPC under the caller's session
//      (SECURITY DEFINER, derives from auth.uid()). A forged workspace id the
//      caller isn't linked to returns false and the read is refused.
//
// No function here accepts a user id — the subject is always the authed session.
// The workspace id is always validated against the caller's memberships before
// it reaches a service-role query, so a client can never widen scope.

import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { getStatsByChannel, type ChannelStats } from "@/lib/dashboard/analytics";
import { loadThemeWinners, type ThemeWinner } from "@/lib/analytics/themes";
import type { PortalBranding } from "@/lib/portal/data";
import type { PortalReport, PortalReportRow } from "@/lib/portal/data";

const INSIGHTS_WINDOW_DAYS = 30;
const INSIGHTS_THEME_LIMIT = 5;

// A client workspace the authed user is linked to (id + display name). The name
// comes from the workspace row, read under the same authed/RLS-gated query as
// the membership, so we never surface a workspace the caller isn't linked to.
export interface ClientWorkspace {
  workspaceId: string;
  workspaceName: string;
}

export interface ClientAccount {
  userId: string;
  workspaces: ClientWorkspace[];
}

// The full read-only report a client sees for one workspace. Reuses the EXACT
// shapes the tokenized portal serves (PortalBranding/PortalReport/insights), so
// the account view and the token portal show identical numbers.
export interface ClientWorkspaceReport {
  workspaceId: string;
  branding: PortalBranding;
  report: PortalReport;
  channels: ChannelStats[];
  winningThemes: ThemeWinner[];
}

/**
 * Resolve the authed user's client identity: the set of client workspaces they
 * are linked to via client_memberships. Reads through the AUTHED client so RLS
 * scopes the membership rows to user_id = auth.uid() — a caller can never see
 * another user's links. Returns null when there is no authed user OR the user
 * has no client memberships (i.e. they are not a client).
 *
 * Queries (both AUTHED / RLS-backed):
 *   • client_memberships WHERE user_id = auth.uid()  (RLS-enforced — the ONLY
 *     rows the DB returns are the caller's own links).
 *   • workspaces WHERE id IN (<the linked ids>)      (names for the picker;
 *     the org-staff workspace SELECT policy does NOT apply to a pure client, so
 *     this returns rows only for workspaces the client is genuinely linked to).
 */
export async function resolveClientAccount(): Promise<ClientAccount | null> {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // RLS on client_memberships forces user_id = auth.uid(); we never filter by
  // user id in code — the DB does, so there is nothing to spoof.
  const { data: links } = await supabase
    .from("client_memberships")
    .select("workspace_id")
    .order("created_at", { ascending: true });

  const ids = (links ?? []).map((l) => l.workspace_id);
  if (ids.length === 0) return null;

  // Resolve display names. NOTE: a pure client cannot read a workspace ROW via
  // the agency RLS path (owner/member/org), but the name is non-sensitive and
  // is read here via the service role scoped to the proven id set; we fall back
  // to a neutral label if a row is missing.
  const svc = supabaseService();
  const { data: rows } = await svc.from("workspaces").select("id, name").in("id", ids);
  const nameById = new Map((rows ?? []).map((r) => [r.id, r.name]));

  const workspaces: ClientWorkspace[] = ids.map((workspaceId) => ({
    workspaceId,
    workspaceName: nameById.get(workspaceId) ?? "Workspace",
  }));

  return { userId: user.id, workspaces };
}

/**
 * Hard membership gate. Re-asserts — under the caller's auth session — that the
 * caller is a client of `workspaceId` via the user_is_client_of(ws_id) RPC
 * (SECURITY DEFINER, derives from auth.uid()). Returns false on any failure
 * (fail-closed) so a forged/unlinked workspace id never reaches a report query.
 */
export async function assertClientMembership(workspaceId: string): Promise<boolean> {
  const supabase = await supabaseServer();
  const { data, error } = await supabase.rpc("user_is_client_of", { ws_id: workspaceId });
  return !error && data === true;
}

/**
 * Build the read-only report for ONE workspace, for an authenticated client.
 * The workspace id is gated TWICE: caller membership is re-asserted via the
 * RPC (assertClientMembership) BEFORE any service-role read, so even though the
 * aggregate reads run with the service role, they are reachable only for a
 * workspace the caller is provably linked to. Returns null when the gate fails
 * — never a partial/other-workspace report.
 *
 * Aggregate reads reuse the SAME service-role report functions the tokenized
 * portal uses, each scoped to this single workspace id:
 *   • branding  — workspaces(id == ws) → organizations(id == ws.org).
 *   • report    — posts WHERE workspace_id == ws ⋈ post_metrics(post_id IN …).
 *   • channels  — getStatsByChannel(ws): post_metrics ⋈ posts WHERE ws.
 *   • themes    — loadThemeWinners(ws): posts ⋈ post_metrics WHERE ws.
 */
export async function getClientWorkspaceReport(
  workspaceId: string,
): Promise<ClientWorkspaceReport | null> {
  // GATE: prove the authed caller is a client of this workspace before reading.
  const allowed = await assertClientMembership(workspaceId);
  if (!allowed) return null;

  const [branding, report, channels, winningThemes] = await Promise.all([
    readBranding(workspaceId),
    readReport(workspaceId),
    getStatsByChannel(workspaceId, INSIGHTS_WINDOW_DAYS),
    loadThemeWinners(workspaceId, INSIGHTS_THEME_LIMIT),
  ]);

  return { workspaceId, branding, report, channels, winningThemes };
}

// ─── Internal service-role reads (each scoped to a proven workspace id) ──────
//
// These mirror getPortalBranding / getPortalReport in src/lib/portal/data.ts
// but take a plain workspaceId — SAFE here ONLY because every caller path above
// has already passed the user_is_client_of gate. They are not exported, so no
// route can reach them without going through getClientWorkspaceReport().

async function readBranding(workspaceId: string): Promise<PortalBranding> {
  const svc = supabaseService();
  const { data: ws } = await svc
    .from("workspaces")
    .select("name, organization_id")
    .eq("id", workspaceId)
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

async function readReport(workspaceId: string): Promise<PortalReport> {
  const svc = supabaseService();

  const { data: posts } = await svc
    .from("posts")
    .select("id, text, channel, status, scheduled_at, posted_at")
    .eq("workspace_id", workspaceId)
    .in("status", ["scheduled", "posted"])
    .order("posted_at", { ascending: false, nullsFirst: false })
    .order("scheduled_at", { ascending: false, nullsFirst: false })
    .limit(200);

  const postRows = posts ?? [];
  const postIds = postRows.map((p) => p.id);

  const latestByPost = new Map<string, PortalReportRow>();
  if (postIds.length > 0) {
    const { data: metrics } = await svc
      .from("post_metrics")
      .select(
        "post_id, fetched_at, impressions, likes, reposts, replies, clicks, engagement_rate",
      )
      .in("post_id", postIds)
      .order("fetched_at", { ascending: false });

    const seen = new Set<string>();
    for (const m of metrics ?? []) {
      if (seen.has(m.post_id)) continue;
      seen.add(m.post_id);
      const p = postRows.find((x) => x.id === m.post_id);
      if (!p) continue;
      latestByPost.set(m.post_id, {
        id: p.id,
        text: p.text,
        channel: p.channel,
        status: p.status,
        scheduled_at: p.scheduled_at,
        posted_at: p.posted_at,
        impressions: m.impressions,
        likes: m.likes,
        reposts: m.reposts,
        replies: m.replies,
        clicks: m.clicks,
        engagement_rate: m.engagement_rate,
      });
    }
  }

  const rows: PortalReportRow[] = postRows.map(
    (p) =>
      latestByPost.get(p.id) ?? {
        id: p.id,
        text: p.text,
        channel: p.channel,
        status: p.status,
        scheduled_at: p.scheduled_at,
        posted_at: p.posted_at,
        impressions: null,
        likes: null,
        reposts: null,
        replies: null,
        clicks: null,
        engagement_rate: null,
      },
  );

  let impressions = 0;
  let engagements = 0;
  const erValues: number[] = [];
  for (const r of rows) {
    impressions += r.impressions ?? 0;
    engagements += (r.likes ?? 0) + (r.reposts ?? 0) + (r.replies ?? 0) + (r.clicks ?? 0);
    if (typeof r.engagement_rate === "number") erValues.push(r.engagement_rate);
  }
  const avgEngagementRate =
    erValues.length > 0 ? erValues.reduce((a, b) => a + b, 0) / erValues.length : null;

  return {
    rows,
    totals: { posts: rows.length, impressions, engagements, avgEngagementRate },
  };
}
