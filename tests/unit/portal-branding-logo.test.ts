import { describe, expect, it } from "vitest";

// ── Unit: white-label logo asset helpers (src/lib/portal/branding.ts) ────────
//
// Migration 033 adds a dedicated, org-scoped `org-branding` storage bucket for
// the white-label logo. These helpers are the single source of truth shared by
// the upload server action, the bucket DDL, and the report renderer:
//   • ORG_BRANDING_BUCKET — the bucket id the action uploads to.
//   • ALLOWED_LOGO_MIME    — the mime allowlist (must match the bucket's
//                            allowed_mime_types and the action's validation).
//   • logoExtForMime       — maps a validated mime to the stored file extension.
//
// The object path layout is `<organizationId>/logo-<ts>.<ext>`; the bucket RLS
// keys org membership off the FIRST path segment, so keeping the extension
// mapping correct (and SVG in the allowlist) is what makes an SVG logo round-
// trip through storage instead of being rejected.

import {
  ORG_BRANDING_BUCKET,
  ALLOWED_LOGO_MIME,
  logoExtForMime,
  resolveTheme,
  safeColor,
  DEFAULT_PRIMARY,
  DEFAULT_ACCENT,
} from "@/lib/portal/branding";

describe("org-branding logo helpers", () => {
  it("uses the dedicated org-scoped bucket (not post-media)", () => {
    expect(ORG_BRANDING_BUCKET).toBe("org-branding");
  });

  it("allows exactly png / jpeg / webp / svg (SVG included)", () => {
    expect([...ALLOWED_LOGO_MIME].sort()).toEqual(
      ["image/jpeg", "image/png", "image/svg+xml", "image/webp"].sort(),
    );
    // SVG is the one the old post-media bucket excluded — assert it explicitly.
    expect(ALLOWED_LOGO_MIME).toContain("image/svg+xml");
  });

  it("maps each allowed mime to the right extension", () => {
    expect(logoExtForMime("image/png")).toBe("png");
    expect(logoExtForMime("image/webp")).toBe("webp");
    expect(logoExtForMime("image/svg+xml")).toBe("svg");
    expect(logoExtForMime("image/jpeg")).toBe("jpg");
  });

  it("falls back to jpg for an unexpected mime (defensive default)", () => {
    expect(logoExtForMime("application/octet-stream")).toBe("jpg");
  });
});

describe("resolveTheme — logo passthrough", () => {
  it("surfaces the stored logo URL so both web + PDF render the real logo", () => {
    const logoUrl = "https://example.supabase.co/storage/v1/object/public/org-branding/org-1/logo-1.png";
    const theme = resolveTheme({
      workspaceName: "Client WS",
      organizationName: "Acme Agency",
      logoUrl,
      colorPrimary: "#111111",
      colorAccent: "#22aa55",
    });
    expect(theme.logoUrl).toBe(logoUrl);
    expect(theme.brandName).toBe("Acme Agency");
    expect(theme.primary).toBe("#111111");
    expect(theme.accent).toBe("#22aa55");
  });

  it("null logo → null (the surfaces render their placeholder)", () => {
    const theme = resolveTheme({
      workspaceName: "Client WS",
      organizationName: null,
      logoUrl: null,
      colorPrimary: null,
      colorAccent: null,
    });
    expect(theme.logoUrl).toBeNull();
    // Falls back to the workspace name + neutral default colors.
    expect(theme.brandName).toBe("Client WS");
    expect(theme.primary).toBe(DEFAULT_PRIMARY);
    expect(theme.accent).toBe(DEFAULT_ACCENT);
  });

  it("rejects a non-hex color (style-attribute injection defense)", () => {
    expect(safeColor("red; background:url(x)", DEFAULT_ACCENT)).toBe(DEFAULT_ACCENT);
    expect(safeColor("#abc", DEFAULT_ACCENT)).toBe("#abc");
  });
});
