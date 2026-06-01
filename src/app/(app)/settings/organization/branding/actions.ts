"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import {
  mintPortalToken,
  revokePortalToken,
} from "@/lib/portal/manage";
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

const ALLOWED_LOGO_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]);
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

  // Optional logo upload. Stored in the public post-media bucket under an
  // org-branding/ prefix (no new bucket / migration needed).
  const file = formData.get("logo");
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_LOGO_BYTES) return { error: "Logo must be 2MB or smaller.", ok: false };
    if (!ALLOWED_LOGO_MIME.has(file.type)) {
      return { error: "Logo must be PNG, JPEG, WebP, or SVG.", ok: false };
    }
    const ext =
      file.type === "image/png"
        ? "png"
        : file.type === "image/webp"
          ? "webp"
          : file.type === "image/svg+xml"
            ? "svg"
            : "jpg";
    const path = `org-branding/${organizationId}/logo-${Date.now()}.${ext}`;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const svc = supabaseService();
    const { error: upErr } = await svc.storage
      .from("post-media")
      .upload(path, bytes, { contentType: file.type, upsert: true });
    if (upErr) return { error: `Logo upload failed: ${upErr.message}`, ok: false };
    const { data: pub } = svc.storage.from("post-media").getPublicUrl(path);
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
