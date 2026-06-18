import { describe, expect, it } from "vitest";

// ── Unit: safe internal-path guard (src/lib/auth/redirect.ts) ────────────────
//
// `next` on /auth/callback and the login form is attacker-influenceable, so the
// guard must refuse anything that could leave our origin. These cases lock in
// the open-redirect protections.

import { safeInternalPath } from "@/lib/auth/redirect";

describe("safeInternalPath", () => {
  it("allows ordinary root-relative paths", () => {
    expect(safeInternalPath("/dashboard")).toBe("/dashboard");
    expect(safeInternalPath("/reset-password")).toBe("/reset-password");
    expect(safeInternalPath("/onboarding/workspace?x=1#y")).toBe("/onboarding/workspace?x=1#y");
  });

  it("falls back when next is missing or empty", () => {
    expect(safeInternalPath(null)).toBe("/onboarding/workspace");
    expect(safeInternalPath(undefined)).toBe("/onboarding/workspace");
    expect(safeInternalPath("")).toBe("/onboarding/workspace");
  });

  it("honours a custom fallback", () => {
    expect(safeInternalPath(null, "/dashboard")).toBe("/dashboard");
    expect(safeInternalPath("https://evil.com", "/dashboard")).toBe("/dashboard");
  });

  it("rejects absolute URLs", () => {
    expect(safeInternalPath("https://evil.com")).toBe("/onboarding/workspace");
    expect(safeInternalPath("http://evil.com/path")).toBe("/onboarding/workspace");
  });

  it("rejects protocol-relative and backslash-trick paths", () => {
    expect(safeInternalPath("//evil.com")).toBe("/onboarding/workspace");
    expect(safeInternalPath("/\\evil.com")).toBe("/onboarding/workspace");
    expect(safeInternalPath("/%5Cevil.com")).toBe("/onboarding/workspace");
    expect(safeInternalPath("/%5cevil.com")).toBe("/onboarding/workspace");
  });

  it("rejects control-char smuggling that the URL parser strips (tab/LF/CR)", () => {
    // The WHATWG URL parser removes 0x09/0x0A/0x0D before parsing, turning
    // "/<TAB>/evil.com" into "//evil.com" → the guard must strip them first.
    const TAB = String.fromCharCode(9);
    const LF = String.fromCharCode(10);
    const CR = String.fromCharCode(13);
    expect(safeInternalPath(`/${TAB}/evil.com`)).toBe("/onboarding/workspace");
    expect(safeInternalPath(`/${LF}/evil.com`)).toBe("/onboarding/workspace");
    expect(safeInternalPath(`/${CR}/evil.com`)).toBe("/onboarding/workspace");
    // Leading control char before the slash must not sneak past the "/" check.
    expect(safeInternalPath(`${TAB}//evil.com`)).toBe("/onboarding/workspace");
  });

  it("rejects non-path values that aren't absolute paths", () => {
    expect(safeInternalPath("dashboard")).toBe("/onboarding/workspace");
    expect(safeInternalPath("javascript:alert(1)")).toBe("/onboarding/workspace");
  });
});
