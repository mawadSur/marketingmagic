import { describe, expect, it } from "vitest";

// ── Unit: friendly auth-error copy (src/lib/auth/messages.ts) ────────────────
//
// Confirmation/recovery links fail for a handful of boring reasons. The mapper
// turns Supabase's raw strings into copy a human can act on; these cases pin the
// known translations and the "surface the unknown rather than blank-screen it"
// fallback.

import { friendlyAuthError } from "@/lib/auth/messages";

describe("friendlyAuthError", () => {
  it("explains the cross-browser PKCE failure", () => {
    const raw = "invalid request: both auth code and code verifier should be non-empty";
    expect(friendlyAuthError(raw)).toMatch(/same browser/i);
  });

  it("explains an expired link", () => {
    expect(friendlyAuthError("otp_expired")).toMatch(/expired/i);
    expect(friendlyAuthError("Email link is invalid or has expired")).toMatch(/expired/i);
  });

  it("explains an already-used / denied link", () => {
    expect(friendlyAuthError("access_denied")).toMatch(/no longer valid/i);
  });

  it("returns a generic line for empty input", () => {
    expect(friendlyAuthError(null)).toMatch(/something went wrong/i);
    expect(friendlyAuthError("")).toMatch(/something went wrong/i);
    expect(friendlyAuthError(undefined)).toMatch(/something went wrong/i);
  });

  it("surfaces an unknown raw message instead of swallowing it", () => {
    const weird = "Database connection pool exhausted";
    expect(friendlyAuthError(weird)).toBe(weird);
  });
});
