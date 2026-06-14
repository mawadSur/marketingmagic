import { describe, expect, it } from "vitest";
import {
  generateKey,
  hashKey,
  looksLikeApiKey,
  isApiScope,
  API_SCOPES,
} from "@/lib/api/keys";

// ── Unit: API key minting + hashing (src/lib/api/keys.ts) ─────────────────────
// The security contract: the raw key is never derivable from what we store, the
// hash is deterministic, and only well-formed keys are accepted for lookup.

describe("generateKey", () => {
  it("mints a key with the mm_live_ prefix and a long secret", () => {
    const k = generateKey();
    expect(k.raw.startsWith("mm_live_")).toBe(true);
    // mm_live_ (8) + 43 base64url chars of 32 random bytes.
    expect(k.raw.length).toBeGreaterThan(40);
  });

  it("stores a hash that is NOT the raw key (raw is unrecoverable)", () => {
    const k = generateKey();
    expect(k.hash).not.toBe(k.raw);
    expect(k.hash).toBe(hashKey(k.raw));
    // SHA-256 hex is 64 chars.
    expect(k.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the stored prefix is a non-secret identifying slice of the raw key", () => {
    const k = generateKey();
    expect(k.raw.startsWith(k.prefix)).toBe(true);
    expect(k.prefix.length).toBeLessThan(k.raw.length);
  });

  it("produces a unique key each call", () => {
    const a = generateKey();
    const b = generateKey();
    expect(a.raw).not.toBe(b.raw);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("hashKey", () => {
  it("is deterministic", () => {
    expect(hashKey("mm_live_abc")).toBe(hashKey("mm_live_abc"));
  });
  it("differs for different inputs", () => {
    expect(hashKey("mm_live_abc")).not.toBe(hashKey("mm_live_abd"));
  });
});

describe("looksLikeApiKey", () => {
  it("accepts a freshly minted key", () => {
    expect(looksLikeApiKey(generateKey().raw)).toBe(true);
  });
  it("rejects junk, empty, and wrong-prefix strings", () => {
    expect(looksLikeApiKey("")).toBe(false);
    expect(looksLikeApiKey("Bearer foo")).toBe(false);
    expect(looksLikeApiKey("mm_live_")).toBe(false); // prefix only, no secret
    expect(looksLikeApiKey("sk_live_xxxxxxxxxxxxxxxx")).toBe(false);
  });
});

describe("scopes", () => {
  it("recognises every declared scope", () => {
    for (const s of API_SCOPES) expect(isApiScope(s)).toBe(true);
  });
  it("rejects unknown scopes", () => {
    expect(isApiScope("posts:delete")).toBe(false);
    expect(isApiScope("admin")).toBe(false);
  });
});
