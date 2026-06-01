"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import {
  mintPortalToken,
  revokePortalToken,
  recordClientInvite,
} from "@/lib/portal/manage";
import {
  ORG_BRANDING_BUCKET,
  ALLOWED_LOGO_MIME,
  logoExtForMime,
} from "@/lib/portal/branding";
import { resolvePortalToken } from "@/lib/portal/token";
import { renderInviteEmail, sendInviteEmail } from "@/lib/portal/invite-email";
import { siteUrl } from "@/lib/env";
import type { ClientPortalScope } from "@/lib/db/types";

// ─────────────────────────────────────────────────────────────
// Org branding + portal-link settings (Phase E)
// ─────────────────────────────────────────────────────────────
//
// Authorization model: every action proves the caller can manage the org by
// reading it through the AUTHED (RLS-backed) client first and checking
// owner_id == user.id. Branding is owner-only (matches the org page copy:
// "Only the owner can change billing and branding."). Token mint/revoke is
// also owner-gated here for simplicity. Service-role writes happen only after
// that gate passes.

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const colorSchema = z
  .string()
  .trim()
  .regex(HEX_RE, "Use a hex color like #2563eb")
  .optional()
  .or(z.literal(""));

// Mime allowlist + bucket id are shared from @/lib/portal/branding so the
// upload action, the bucket DDL (migration 033), and tests stay in lockstep.
const ALLOWED_LOGO_MIME_SET = new Set<string>(ALLOWED_LOGO_MIME);
const MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2MB — a logo, not a hero image.

export type BrandingState = { error: string | null; ok: boolean };

// Resolve the caller's org and confirm they own it. Returns null on any failure
// so callers surface a single generic authz error.
async function requireOwnedOrg(
  organizationId: string,
): Promise<{ userId: string } | null> {
  if (!z.string().uuid().safeParse(organizationId).success) return null;
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // RLS hides orgs the caller isn't a member of; owner_id check makes this
  // owner-only.
  const { data: org } = await supabase
    .from("organizations")
    .select("id, owner_id")
    .eq("id", organizationId)
    .maybeSingle();
  if (!org || org.owner_id !== user.id) return null;
  return { userId: user.id };
}

export async function updateBrandingAction(
  _prev: BrandingState,
  formData: FormData,
): Promise<BrandingState> {
  const organizationId = String(formData.get("organization_id") ?? "");
  const owner = await requireOwnedOrg(organizationId);
  if (!owner) return { error: "Only the organization owner can change branding.", ok: false };

  const primaryParsed = colorSchema.safeParse(formData.get("color_primary"));
  const accentParsed = colorSchema.safeParse(formData.get("color_accent"));
  if (!primaryParsed.success || !accentParsed.success) {
    return { error: "Colors must be hex values like #2563eb.", ok: false };
  }

  const update: {
    color_primary?: string | null;
    color_accent?: string | null;
    logo_url?: string | null;
  } = {
    color_primary: primaryParsed.data ? primaryParsed.data : null,
    color_accent: accentParsed.data ? accentParsed.data : null,
  };

  // Optional logo upload. Stored in the dedicated, org-scoped `org-branding`
  // bucket (migration 033) under `<organizationId>/...` so its storage RLS
  // (org-membership keyed on the first path segment) actually applies. The
  // bucket's mime allowlist includes SVG, unlike the post-media bucket.
  const file = formData.get("logo");
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_LOGO_BYTES) return { error: "Logo must be 2MB or smaller.", ok: false };
    if (!ALLOWED_LOGO_MIME_SET.has(file.type)) {
      return { error: "Logo must be PNG, JPEG, WebP, or SVG.", ok: false };
    }
    const path = `${organizationId}/logo-${Date.now()}.${logoExtForMime(file.type)}`;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const svc = supabaseService();
    const { error: upErr } = await svc.storage
      .from(ORG_BRANDING_BUCKET)
      .upload(path, bytes, { contentType: file.type, upsert: true });
    if (upErr) return { error: `Logo upload failed: ${upErr.message}`, ok: false };
    const { data: pub } = svc.storage.from(ORG_BRANDING_BUCKET).getPublicUrl(path);
    update.logo_url = pub.publicUrl;
  }

  const svc = supabaseService();
  const { error } = await svc.from("organizations").update(update).eq("id", organizationId);
  if (error) return { error: error.message, ok: false };

  revalidatePath("/settings/organization/branding");
  return { error: null, ok: true };
}

// ─── Portal link (token) management ─────────────────────────────────────

export type MintTokenState = { error: string | null; rawUrl: string | null };

const scopeSchema = z.enum(["approve", "view_reports"]);
const expiryDaysSchema = z.coerce.number().int().min(1).max(365).optional();

export async function mintTokenAction(
  _prev: MintTokenState,
  formData: FormData,
): Promise<MintTokenState> {
  const organizationId = String(formData.get("organization_id") ?? "");
  const workspaceId = String(formData.get("workspace_id") ?? "");
  const owner = await requireOwnedOrg(organizationId);
  if (!owner) return { error: "Only the organization owner can create links.", rawUrl: null };
  if (!z.string().uuid().safeParse(workspaceId).success) {
    return { error: "Pick a client workspace.", rawUrl: null };
  }

  // Confirm the target workspace actually belongs to this org (authed read —
  // RLS scopes it to the caller's orgs). Prevents minting a token for a
  // workspace outside the org the owner controls.
  const supabase = await supabaseServer();
  const { data: ws } = await supabase
    .from("workspaces")
    .select("id, organization_id")
    .eq("id", workspaceId)
    .maybeSingle();
  if (!ws || ws.organization_id !== organizationId) {
    return { error: "That workspace isn't in your organization.", rawUrl: null };
  }

  const scopes: ClientPortalScope[] = [];
  if (scopeSchema.safeParse("approve").success && formData.get("scope_approve")) {
    scopes.push("approve");
  }
  if (formData.get("scope_view_reports")) scopes.push("view_reports");
  if (scopes.length === 0) {
    return { error: "Enable at least one section (approve or reports).", rawUrl: null };
  }

  const label = String(formData.get("label") ?? "").trim().slice(0, 120) || null;

  let expiresAt: string | null = null;
  const daysRaw = formData.get("expires_days");
  if (daysRaw && String(daysRaw).length > 0) {
    const daysParsed = expiryDaysSchema.safeParse(daysRaw);
    if (!daysParsed.success || daysParsed.data === undefined) {
      return { error: "Expiry must be 1–365 days.", rawUrl: null };
    }
    expiresAt = new Date(Date.now() + daysParsed.data * 86_400_000).toISOString();
  }

  try {
    const { rawToken } = await mintPortalToken({
      workspaceId,
      createdBy: owner.userId,
      label,
      scopes,
      expiresAt,
    });
    revalidatePath("/settings/organization/branding");
    return { error: null, rawUrl: `${siteUrl()}/client/${rawToken}` };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to create link.", rawUrl: null };
  }
}

export type RevokeTokenState = { error: string | null };

export async function revokeTokenAction(
  _prev: RevokeTokenState,
  formData: FormData,
): Promise<RevokeTokenState> {
  const organizationId = String(formData.get("organization_id") ?? "");
  const tokenId = String(formData.get("token_id") ?? "");
  const workspaceId = String(formData.get("workspace_id") ?? "");
  const owner = await requireOwnedOrg(organizationId);
  if (!owner) return { error: "Only the organization owner can revoke links." };
  if (
    !z.string().uuid().safeParse(tokenId).success ||
    !z.string().uuid().safeParse(workspaceId).success
  ) {
    return { error: "Bad request." };
  }

  // Re-confirm the workspace is in this org before revoking by (tokenId,
  // workspaceId) — keeps an owner from revoking a token outside their org.
  const supabase = await supabaseServer();
  const { data: ws } = await supabase
    .from("workspaces")
    .select("id, organization_id")
    .eq("id", workspaceId)
    .maybeSingle();
  if (!ws || ws.organization_id !== organizationId) {
    return { error: "That workspace isn't in your organization." };
  }

  const { error } = await revokePortalToken(tokenId, workspaceId);
  if (error) return { error };
  revalidatePath("/settings/organization/branding");
  return { error: null };
}

// ─── Email the share link to the client ─────────────────────────────────
//
// Authorization model (org-admin-only): emailing a client their portal link is
// gated on the org-admin role (owner OR 'admin' org_membership) via the
// user_is_org_admin(org_id) RPC, evaluated under the caller's auth session
// (SECURITY DEFINER). A 'manager' member or a non-member is rejected — same
// gate as add-client / billing. We then re-validate the provided link by
// resolving the raw token to a PortalContext and proving its workspace is in
// THIS org (no emailing a token outside the org). The Resend send degrades
// gracefully (skip, not throw) when RESEND_API_KEY is unset.

export type EmailInviteState = { error: string | null; status: null | "sent" | "skipped" };

const emailInviteSchema = z.object({
  organization_id: z.string().uuid(),
  recipient: z.string().trim().email(),
  portal_url: z.string().trim().url(),
});

// Confirm the caller is an org admin (owner or 'admin'). Returns the caller's
// user id on success, null otherwise — callers surface a single authz error.
async function requireOrgAdmin(organizationId: string): Promise<{ userId: string } | null> {
  if (!z.string().uuid().safeParse(organizationId).success) return null;
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: isAdmin, error } = await supabase.rpc("user_is_org_admin", {
    org_id: organizationId,
  });
  if (error || isAdmin !== true) return null;
  return { userId: user.id };
}

export async function emailInviteAction(
  _prev: EmailInviteState,
  formData: FormData,
): Promise<EmailInviteState> {
  const parsed = emailInviteSchema.safeParse({
    organization_id: formData.get("organization_id"),
    recipient: formData.get("recipient"),
    portal_url: formData.get("portal_url"),
  });
  if (!parsed.success) {
    return { error: "Enter a valid recipient email.", status: null };
  }

  const admin = await requireOrgAdmin(parsed.data.organization_id);
  if (!admin) {
    return { error: "Only an organization admin can email a client link.", status: null };
  }

  // Extract the raw token from the provided /client/<token> URL and resolve it.
  // This proves the link is a live token AND yields its workspace + scopes — we
  // then check the workspace belongs to this org before sending anywhere.
  const rawToken = parsePortalToken(parsed.data.portal_url);
  if (!rawToken) {
    return { error: "That doesn't look like a portal link from this app.", status: null };
  }
  const ctx = await resolvePortalToken(rawToken);
  if (!ctx) {
    return { error: "That link is invalid, expired, or revoked.", status: null };
  }

  // The token's workspace must be a client of THIS org (authed read; RLS scopes
  // it to the caller's orgs). Prevents emailing a token outside the org.
  const supabase = await supabaseServer();
  const { data: ws } = await supabase
    .from("workspaces")
    .select("id, name, organization_id")
    .eq("id", ctx.workspaceId)
    .maybeSingle();
  if (!ws || ws.organization_id !== parsed.data.organization_id) {
    return { error: "That link isn't for a client in your organization.", status: null };
  }

  // Org branding for the email (logo + accent). Read via the authed client —
  // the caller is an admin of this org, so RLS allows it.
  const { data: org } = await supabase
    .from("organizations")
    .select("name, logo_url, color_accent")
    .eq("id", parsed.data.organization_id)
    .maybeSingle();

  const rendered = renderInviteEmail({
    workspaceName: ws.name,
    portalUrl: parsed.data.portal_url,
    scopes: [...ctx.scopes],
    branding: {
      orgName: org?.name ?? "",
      logoUrl: org?.logo_url ?? null,
      colorAccent: org?.color_accent ?? null,
    },
  });

  const result = await sendInviteEmail(parsed.data.recipient, rendered);

  if (result.status === "failed") {
    return { error: `Couldn't send the email: ${result.reason}`, status: null };
  }

  // Record the invite for the audit trail (best-effort; never blocks the send).
  // Only record an actually-sent email — a skipped (unconfigured) send isn't an
  // invite that reached anyone.
  if (result.status === "sent") {
    await recordClientInvite({
      workspaceId: ctx.workspaceId,
      tokenId: ctx.tokenId,
      recipientEmail: parsed.data.recipient,
      createdBy: admin.userId,
    });
  }

  return { error: null, status: result.status };
}

// Pull the raw token out of a /client/<token> URL. Returns null when the URL
// isn't a portal link (wrong path shape), so a pasted arbitrary URL is rejected
// before it reaches the token resolver.
function parsePortalToken(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length !== 2 || segments[0] !== "client") return null;
  return segments[1] ?? null;
}
