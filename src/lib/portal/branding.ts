// White-label branding helpers shared by the portal UI and the report PDF.
//
// Colors come from org-owner input (settings UI) and are validated there, but
// they also flow into inline styles / a server-rendered HTML document, so we
// sanitize again at render time: only #rgb / #rrggbb hex is allowed through.
// Anything else falls back to a neutral default — never inject raw user text
// into a style attribute.

import type { PortalBranding } from "@/lib/portal/data";
import { PORTAL_DEFAULT_ACCENT, PORTAL_DEFAULT_PRIMARY } from "@/lib/design-tokens";

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

// Re-exported from the centralized design tokens; same values as before.
export const DEFAULT_PRIMARY = PORTAL_DEFAULT_PRIMARY;
export const DEFAULT_ACCENT = PORTAL_DEFAULT_ACCENT;

// ─── White-label logo asset storage (migration 033) ──────────────────────
//
// Dedicated, org-scoped Supabase storage bucket for the white-label logo.
// Object layout is `<organizationId>/logo-<ts>.<ext>`; the bucket's RLS keys
// org membership off the first path segment, so the organization id MUST be the
// leading segment. The upload server action validates mime + size before
// writing; these helpers keep the bucket id and the mime→extension mapping in
// one shared, testable place (consumed by the branding upload action).

export const ORG_BRANDING_BUCKET = "org-branding";

// Mime types we accept for a logo. Kept in lockstep with the bucket's
// allowed_mime_types in migration 033 and the upload action's validation.
export const ALLOWED_LOGO_MIME = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
] as const;

// Map a validated logo mime type to its file extension. Defaults to "jpg" for
// image/jpeg; the caller is expected to have already gated on ALLOWED_LOGO_MIME.
export function logoExtForMime(mime: string): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    default:
      return "jpg";
  }
}

// Validate a color for safe use in inline styles. Returns the fallback for any
// non-hex value (defends the PDF/HTML output against style-attribute injection).
export function safeColor(value: string | null | undefined, fallback: string): string {
  if (value && HEX_RE.test(value.trim())) return value.trim();
  return fallback;
}

export interface ResolvedTheme {
  primary: string;
  accent: string;
  logoUrl: string | null;
  brandName: string;
}

export function resolveTheme(branding: PortalBranding): ResolvedTheme {
  return {
    primary: safeColor(branding.colorPrimary, DEFAULT_PRIMARY),
    accent: safeColor(branding.colorAccent, DEFAULT_ACCENT),
    logoUrl: branding.logoUrl,
    brandName: branding.organizationName ?? branding.workspaceName,
  };
}
