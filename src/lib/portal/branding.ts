// White-label branding helpers shared by the portal UI and the report PDF.
//
// Colors come from org-owner input (settings UI) and are validated there, but
// they also flow into inline styles / a server-rendered HTML document, so we
// sanitize again at render time: only #rgb / #rrggbb hex is allowed through.
// Anything else falls back to a neutral default — never inject raw user text
// into a style attribute.

import type { PortalBranding } from "@/lib/portal/data";

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export const DEFAULT_PRIMARY = "#0a0a0a";
export const DEFAULT_ACCENT = "#2563eb";

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
