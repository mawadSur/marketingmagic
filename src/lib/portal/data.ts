// ─────────────────────────────────────────────────────────────
// Client portal — hardened data-access layer (Phase D, migration 029)
// ─────────────────────────────────────────────────────────────
//
// SECURITY — this module is the entire trust boundary for the portal.
//
// The portal path has no auth user, so RLS does not apply. Every function here
// runs through the SERVICE ROLE (RLS-bypassing) and MUST therefore:
//   • take a PortalContext (already validated by resolvePortalToken), and
//   • filter EVERY query with .eq("workspace_id", ctx.workspaceId) — directly,
//     or transitively through a workspace-scoped parent row whose id set we
//     derived under the same filter (see post_metrics below).
//   • gate scope-restricted reads/writes via assertScope().
//
// No function may accept a workspaceId argument — the workspace comes only from
// the context, so a caller can never widen the scope. No function may read a
// table by a free id alone; the id must be proven to belong to the workspace
// first. Audit checklist of every query lives in the per-function comments and
// is reproduced in the handoff so the reviewer can verify scoping.

import { supabaseService } from "@/lib/supabase/service";
import { assertScope, type PortalContext } from "@/lib/portal/token";
import type { Channel, PostStatus, RejectionReason } from "@/lib/db/types";

// ─── Branding (white-label) ─────────────────────────────────────────────
//
// The portal renders the agency's branding, resolved via the workspace's org.
// A solo workspace (organization_id null) or an org with no branding set
// yields null fields — the portal falls back to neutral defaults. This is the
// ONE place that reads outside the workspace row; it does so by first reading
// the workspace (scoped to ctx) then following its organization_id. We never
// take an org id from the caller.

export interface PortalBranding {
  workspaceName: string;
  organizationName: string | null;
  logoUrl: string | null;
  colorPrimary: string | null;
  colorAccent: string | null;
}

export async function getPortalBranding(ctx: PortalContext): Promise<PortalBranding> {
  const svc = supabaseService();

  // Query 1 — workspace, scoped by id == ctx.workspaceId. (PK equality is the
  // workspace scope here.)
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

  // Query 2 — organization, scoped by the organization_id we just read off the
  // workspace (which itself was scoped to ctx). We do NOT accept an org id from
  // anywhere else.
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

// ─── Approvals: pending drafts (scope: approve) ─────────────────────────

export interface PortalPost {
  id: string;
  text: string;
  theme: string | null;
  channel: Channel;
  status: PostStatus;
  scheduled_at: string | null;
  mediaPublicUrl: string | null;
}

interface PostMediaItem {
  storage_path?: string;
}

function firstMediaUrl(media: unknown): string | null {
  const arr = Array.isArray(media) ? (media as PostMediaItem[]) : [];
  const path = arr[0]?.storage_path;
  if (!path) return null;
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "") ?? "";
  return `${base}/storage/v1/object/public/post-media/${path}`;
}

/**
 * Pending-approval drafts for the workspace. Scope-gated on 'approve'.
 * Query: posts WHERE workspace_id == ctx AND status == 'pending_approval'.
 */
export async function listPendingPosts(ctx: PortalContext): Promise<PortalPost[]> {
  assertScope(ctx, "approve");
  const svc = supabaseService();

  const { data } = await svc
    .from("posts")
    .select("id, text, theme, channel, status, scheduled_at, media")
    .eq("workspace_id", ctx.workspaceId)
    .eq("status", "pending_approval")
    .order("scheduled_at", { ascending: true });

  return (data ?? []).map((p) => ({
    id: p.id,
    text: p.text,
    theme: p.theme,
    channel: p.channel,
    status: p.status,
    scheduled_at: p.scheduled_at,
    mediaPublicUrl: firstMediaUrl(p.media),
  }));
}

/**
 * Load a single post, but ONLY if it belongs to ctx.workspaceId. Returns null
 * otherwise — this is the per-row workspace gate the write actions depend on,
 * so a forged post id from another workspace resolves to null and is rejected.
 * Query: posts WHERE id == postId AND workspace_id == ctx.
 */
export async function loadWorkspacePost(
  ctx: PortalContext,
  postId: string,
): Promise<{ id: string; status: PostStatus } | null> {
  const svc = supabaseService();
  const { data } = await svc
    .from("posts")
    .select("id, status")
    .eq("id", postId)
    .eq("workspace_id", ctx.workspaceId)
    .maybeSingle();
  return data ?? null;
}

/**
 * Approve a pending draft via the portal. Scope-gated on 'approve'. Mirrors the
 * authed queue approvePostAction, but the audit row records client_token_id
 * (user_id left null — the DB CHECK requires exactly one of the two).
 *
 * Queries:
 *   • loadWorkspacePost (posts WHERE id AND workspace_id == ctx) — the gate.
 *   • UPDATE posts SET status,approved_at WHERE id == postId AND workspace_id == ctx.
 *   • INSERT approvals { post_id, client_token_id, user_id:null, action:'approved' }.
 */
export async function approvePostViaPortal(
  ctx: PortalContext,
  postId: string,
): Promise<{ error: string | null }> {
  assertScope(ctx, "approve");
  const post = await loadWorkspacePost(ctx, postId);
  if (!post) return { error: "Post not found." };
  if (post.status !== "pending_approval") {
    return { error: `Cannot approve from ${post.status}.` };
  }

  const svc = supabaseService();
  const now = new Date().toISOString();
  // Re-assert workspace_id on the UPDATE so the write itself is scoped, not
  // only the prior read.
  const { error: updateErr } = await svc
    .from("posts")
    .update({ status: "scheduled", approved_at: now })
    .eq("id", postId)
    .eq("workspace_id", ctx.workspaceId);
  if (updateErr) return { error: updateErr.message };

  const { error: auditErr } = await svc.from("approvals").insert({
    post_id: postId,
    client_token_id: ctx.tokenId,
    user_id: null,
    action: "approved",
    diff: null,
  });
  if (auditErr) return { error: auditErr.message };

  return { error: null };
}

/**
 * Reject a pending draft via the portal. Scope-gated on 'approve'. Same audit
 * shape as approve (client_token_id set, user_id null) plus the rejection
 * reason — mirrors the authed queue rejectPostAction.
 *
 * Queries:
 *   • loadWorkspacePost (posts WHERE id AND workspace_id == ctx) — the gate.
 *   • UPDATE posts SET status='rejected' WHERE id == postId AND workspace_id == ctx.
 *   • INSERT approvals { post_id, client_token_id, user_id:null, action:'rejected', reason }.
 */
export async function rejectPostViaPortal(
  ctx: PortalContext,
  postId: string,
  reason: RejectionReason,
  reasonNote: string | null,
): Promise<{ error: string | null }> {
  assertScope(ctx, "approve");
  const post = await loadWorkspacePost(ctx, postId);
  if (!post) return { error: "Post not found." };
  if (post.status !== "pending_approval") {
    return { error: `Cannot reject from ${post.status}.` };
  }

  const svc = supabaseService();
  const { error: updateErr } = await svc
    .from("posts")
    .update({ status: "rejected" })
    .eq("id", postId)
    .eq("workspace_id", ctx.workspaceId);
  if (updateErr) return { error: updateErr.message };

  const { error: auditErr } = await svc.from("approvals").insert({
    post_id: postId,
    client_token_id: ctx.tokenId,
    user_id: null,
    action: "rejected",
    diff: null,
    reason,
    reason_note: reasonNote,
  });
  if (auditErr) return { error: auditErr.message };

  return { error: null };
}

// ─── Reports: read-only metrics (scope: view_reports) ───────────────────

export interface PortalReportRow {
  id: string;
  text: string;
  channel: Channel;
  status: PostStatus;
  scheduled_at: string | null;
  posted_at: string | null;
  impressions: number | null;
  likes: number | null;
  reposts: number | null;
  replies: number | null;
  clicks: number | null;
  engagement_rate: number | null;
}

export interface PortalReport {
  rows: PortalReportRow[];
  totals: {
    posts: number;
    impressions: number;
    engagements: number;
    avgEngagementRate: number | null;
  };
}

/**
 * Read-only report of scheduled + published posts and their latest metrics.
 * Scope-gated on 'view_reports'. The metrics join is the one place we read
 * post_metrics (which has no workspace_id column), so we constrain it to the
 * post id set we ALREADY derived under the workspace filter — post_metrics is
 * never queried by anything the caller controls.
 *
 * Queries:
 *   • posts WHERE workspace_id == ctx AND status IN ('scheduled','posted').
 *   • post_metrics WHERE post_id IN (<ids from the workspace-scoped query>).
 */
export async function getPortalReport(ctx: PortalContext): Promise<PortalReport> {
  assertScope(ctx, "view_reports");
  const svc = supabaseService();

  // Query 1 — posts, workspace-scoped.
  const { data: posts } = await svc
    .from("posts")
    .select("id, text, channel, status, scheduled_at, posted_at")
    .eq("workspace_id", ctx.workspaceId)
    .in("status", ["scheduled", "posted"])
    .order("posted_at", { ascending: false, nullsFirst: false })
    .order("scheduled_at", { ascending: false, nullsFirst: false })
    .limit(200);

  const postRows = posts ?? [];
  const postIds = postRows.map((p) => p.id);

  // Query 2 — metrics, constrained to the workspace-scoped post id set only.
  // post_metrics has no workspace_id; the id set IS the scope, derived above.
  const latestByPost = new Map<string, PortalReportRow>();
  if (postIds.length > 0) {
    const { data: metrics } = await svc
      .from("post_metrics")
      .select(
        "post_id, fetched_at, impressions, likes, reposts, replies, clicks, engagement_rate",
      )
      .in("post_id", postIds)
      .order("fetched_at", { ascending: false });

    // Keep the most recent metric per post (rows arrive newest-first).
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
