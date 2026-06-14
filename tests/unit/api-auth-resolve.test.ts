import { describe, expect, it } from "vitest";
import { makeFakeService } from "./helpers/fake-supabase";
import { resolveApiKey, generateKey } from "@/lib/api/keys";

// ── Unit: resolveApiKey (src/lib/api/keys.ts) ─────────────────────────────────
// Proves the auth lookup rejects absent / malformed / unknown / revoked keys and
// resolves a live key to its workspace + scopes.

function seedWith(rows: Record<string, unknown>[]) {
  return makeFakeService({ api_keys: rows }) as never;
}

describe("resolveApiKey", () => {
  it("returns null for missing or malformed input", async () => {
    const svc = seedWith([]);
    expect(await resolveApiKey(svc, null)).toBeNull();
    expect(await resolveApiKey(svc, "")).toBeNull();
    expect(await resolveApiKey(svc, "not-a-key")).toBeNull();
  });

  it("resolves a live key to its workspace and scopes", async () => {
    const key = generateKey();
    const svc = seedWith([
      { id: "k1", workspace_id: "ws-A", key_hash: key.hash, scopes: ["posts:write"], revoked_at: null },
    ]);
    const resolved = await resolveApiKey(svc, key.raw);
    expect(resolved).not.toBeNull();
    expect(resolved!.workspaceId).toBe("ws-A");
    expect(resolved!.scopes).toEqual(["posts:write"]);
  });

  it("rejects a revoked key (is(revoked_at,null) filter excludes it)", async () => {
    const key = generateKey();
    const svc = seedWith([
      { id: "k1", workspace_id: "ws-A", key_hash: key.hash, scopes: ["posts:write"], revoked_at: "2026-01-01T00:00:00Z" },
    ]);
    expect(await resolveApiKey(svc, key.raw)).toBeNull();
  });

  it("rejects an unknown key (right shape, wrong secret)", async () => {
    const stored = generateKey();
    const attacker = generateKey();
    const svc = seedWith([
      { id: "k1", workspace_id: "ws-A", key_hash: stored.hash, scopes: [], revoked_at: null },
    ]);
    expect(await resolveApiKey(svc, attacker.raw)).toBeNull();
  });
});
