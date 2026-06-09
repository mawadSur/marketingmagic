import { afterEach, describe, expect, it, vi } from "vitest";

// ── Unit: signed OAuth state (src/lib/social/oauth-state.ts) ─────────────────
//
// The signed `state` is the mobile-robust CSRF check that replaced the
// cookie-only nonce (which mobile in-app browsers / the IG app deep-link drop).
// We mock serverEnv so the HMAC secret (CRON_SECRET) is fixed and offline.

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ CRON_SECRET: "test-cron-secret-aaaaaaaaaaaa" }),
}));

import { signOAuthState, verifyOAuthState } from "@/lib/social/oauth-state";

afterEach(() => vi.clearAllMocks());

describe("signOAuthState / verifyOAuthState", () => {
  it("round-trips a workspace id without any cookie", () => {
    const { state, nonce } = signOAuthState("ws-123");
    const r = verifyOAuthState(state);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.workspaceId).toBe("ws-123");
      expect(r.nonce).toBe(nonce);
    }
  });

  it("rejects a tampered payload (signature no longer matches)", () => {
    const { state } = signOAuthState("ws-123");
    const [encoded, sig] = state.split(".");
    // Flip the workspace by re-encoding a different payload but keep the old sig.
    const forged = Buffer.from(JSON.stringify({ w: "ws-evil", exp: Date.now() + 60000, n: "x" }))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    const r = verifyOAuthState(`${forged}.${sig}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad-signature");
    // sanity: the untampered token's parts are well-formed
    expect(encoded.length).toBeGreaterThan(0);
  });

  it("rejects an expired state", () => {
    const { state } = signOAuthState("ws-123", -1000); // already expired
    const r = verifyOAuthState(state);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("expired");
  });

  it("rejects malformed input", () => {
    expect(verifyOAuthState(null).ok).toBe(false);
    expect(verifyOAuthState("no-dot").ok).toBe(false);
    expect(verifyOAuthState(".").ok).toBe(false);
    expect(verifyOAuthState("garbage.sig").ok).toBe(false);
  });

  it("two calls produce different nonces (state is not reused)", () => {
    const a = signOAuthState("ws-1");
    const b = signOAuthState("ws-1");
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.state).not.toBe(b.state);
  });
});
