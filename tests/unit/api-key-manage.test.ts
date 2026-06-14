import { describe, expect, it } from "vitest";
import { makeFakeService } from "./helpers/fake-supabase";
import { createApiKey, listApiKeys, revokeApiKey } from "@/lib/api/manage";
import { hashKey } from "@/lib/api/keys";

// ── Unit: API-key management (src/lib/api/manage.ts) ──────────────────────────
// The cookie-authed UI path. Pins: create returns the raw key ONCE and stores
// only its hash; listing never exposes the hash; revoke is workspace-scoped.

function svcWith(rows: Record<string, unknown>[] = []) {
  return makeFakeService({ api_keys: rows });
}

describe("createApiKey", () => {
  it("returns the raw key once and stores only its hash", async () => {
    const fake = svcWith();
    const created = await createApiKey(fake as never, {
      workspaceId: "ws-A",
      name: "n8n",
      scopes: ["posts:write", "channels:read"],
      createdBy: "user-1",
    });
    expect(created.raw.startsWith("mm_live_")).toBe(true);

    const stored = fake._db.api_keys![0]!;
    // The raw secret is NOT persisted anywhere — only the hash + a prefix slice.
    expect(stored.key_hash).toBe(hashKey(created.raw));
    expect(Object.values(stored)).not.toContain(created.raw);
    expect(stored.workspace_id).toBe("ws-A");
    expect(stored.created_by).toBe("user-1");
  });

  it("rejects an empty scope set", async () => {
    const fake = svcWith();
    await expect(
      createApiKey(fake as never, { workspaceId: "ws-A", name: "x", scopes: [], createdBy: null }),
    ).rejects.toThrow(/at least one scope/i);
  });

  it("rejects an unknown scope (never persists junk)", async () => {
    const fake = svcWith();
    await expect(
      createApiKey(fake as never, {
        workspaceId: "ws-A",
        name: "x",
        scopes: ["posts:delete"],
        createdBy: null,
      }),
    ).rejects.toThrow(/unknown scope/i);
    expect(fake._db.api_keys!.length).toBe(0);
  });

  it("requires a name", async () => {
    const fake = svcWith();
    await expect(
      createApiKey(fake as never, { workspaceId: "ws-A", name: "  ", scopes: ["posts:read"], createdBy: null }),
    ).rejects.toThrow(/name is required/i);
  });
});

describe("listApiKeys", () => {
  it("returns metadata only — never the hash — and only live keys", async () => {
    const fake = svcWith([
      { id: "k1", workspace_id: "ws-A", name: "live", key_prefix: "mm_live_aaaa", key_hash: "HASH1", scopes: ["posts:read"], last_used_at: null, revoked_at: null, created_at: "2026-01-02T00:00:00Z" },
      { id: "k2", workspace_id: "ws-A", name: "dead", key_prefix: "mm_live_bbbb", key_hash: "HASH2", scopes: [], last_used_at: null, revoked_at: "2026-01-03T00:00:00Z", created_at: "2026-01-01T00:00:00Z" },
    ]);
    const keys = await listApiKeys(fake as never, "ws-A");
    expect(keys.map((k) => k.id)).toEqual(["k1"]); // revoked excluded
    expect(JSON.stringify(keys)).not.toContain("HASH1");
    expect(keys[0]).not.toHaveProperty("key_hash");
  });

  it("is scoped to the workspace (never lists another workspace's keys)", async () => {
    const fake = svcWith([
      { id: "k1", workspace_id: "ws-A", name: "a", key_prefix: "p", key_hash: "h", scopes: [], last_used_at: null, revoked_at: null, created_at: "2026-01-01T00:00:00Z" },
      { id: "k2", workspace_id: "ws-B", name: "b", key_prefix: "p", key_hash: "h", scopes: [], last_used_at: null, revoked_at: null, created_at: "2026-01-01T00:00:00Z" },
    ]);
    const keys = await listApiKeys(fake as never, "ws-A");
    expect(keys.map((k) => k.id)).toEqual(["k1"]);
  });
});

describe("revokeApiKey", () => {
  it("revokes a key in the workspace and it stops being listed", async () => {
    const fake = svcWith([
      { id: "k1", workspace_id: "ws-A", name: "a", key_prefix: "p", key_hash: "h", scopes: [], last_used_at: null, revoked_at: null, created_at: "2026-01-01T00:00:00Z" },
    ]);
    expect(await revokeApiKey(fake as never, "ws-A", "k1")).toBe(true);
    expect(fake._db.api_keys![0]!.revoked_at).not.toBeNull();
    expect(await listApiKeys(fake as never, "ws-A")).toHaveLength(0);
  });

  it("CANNOT revoke a key belonging to another workspace", async () => {
    const fake = svcWith([
      { id: "k2", workspace_id: "ws-B", name: "b", key_prefix: "p", key_hash: "h", scopes: [], last_used_at: null, revoked_at: null, created_at: "2026-01-01T00:00:00Z" },
    ]);
    // ws-A tries to revoke ws-B's key by id → no row matches the (ws, id) pair.
    expect(await revokeApiKey(fake as never, "ws-A", "k2")).toBe(false);
    expect(fake._db.api_keys![0]!.revoked_at ?? null).toBeNull(); // untouched
  });
});
