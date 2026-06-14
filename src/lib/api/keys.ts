import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";

// ─── Public API keys ──────────────────────────────────────────────────────
//
// Key format: `mm_live_<43 base64url chars>` (32 random bytes). The `mm_live_`
// prefix makes a leaked key greppable in logs and detectable by secret
// scanners. We store ONLY the SHA-256 hash — the raw key is shown exactly once
// at creation and is unrecoverable afterward (GitHub-PAT / Stripe model).
//
//   raw:    mm_live_3kQ2…(43)         ← returned ONCE to the user
//   prefix: mm_live_3kQ2             ← stored, shown in the UI to identify a key
//   hash:   sha256(raw) hex          ← stored, used for lookup at auth time

const KEY_PREFIX = "mm_live_";
// Length of the human-identifiable slice we persist as key_prefix (prefix tag +
// first 8 chars of the secret). Non-secret; just enough to disambiguate in a list.
const PREFIX_DISPLAY_LEN = KEY_PREFIX.length + 8;

// The set of scopes a key can hold. Each scoped route declares the scope it
// requires; the middleware rejects (403) when the key lacks it. Keep this list
// the single source of truth — the management UI offers exactly these.
export const API_SCOPES = [
  "channels:read",
  "posts:read",
  "posts:write",
  "plans:read",
  "plans:write",
  "analytics:read",
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export function isApiScope(value: string): value is ApiScope {
  return (API_SCOPES as readonly string[]).includes(value);
}

export interface GeneratedKey {
  /** The full secret — returned to the caller ONCE, never stored. */
  raw: string;
  /** Non-secret identifying slice persisted as `key_prefix`. */
  prefix: string;
  /** SHA-256 hex of `raw`, persisted as `key_hash`. */
  hash: string;
}

/** Mint a fresh API key. Caller persists `prefix` + `hash`, returns `raw` once. */
export function generateKey(): GeneratedKey {
  // 32 bytes → 43 base64url chars. base64url avoids `+` `/` `=` so the key is
  // safe in an Authorization header and URL without escaping.
  const secret = randomBytes(32).toString("base64url");
  const raw = `${KEY_PREFIX}${secret}`;
  return { raw, prefix: raw.slice(0, PREFIX_DISPLAY_LEN), hash: hashKey(raw) };
}

/** SHA-256 hex of a raw key. Deterministic — the same input always hashes the same. */
export function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** True when a string looks like one of our keys (cheap pre-check before hashing). */
export function looksLikeApiKey(value: string): boolean {
  return value.startsWith(KEY_PREFIX) && value.length > PREFIX_DISPLAY_LEN;
}

/** Constant-time comparison of two hex hashes (defends against timing probes). */
function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export interface ResolvedKey {
  keyId: string;
  workspaceId: string;
  scopes: string[];
}

/**
 * Resolve a raw API key to its workspace + scopes, or null when the key is
 * absent, malformed, unknown, or revoked. On success, stamps last_used_at
 * (best-effort; a stamp failure never blocks the request).
 *
 * Uses the SERVICE client because the caller is unauthenticated (no cookie) —
 * RLS can't apply. The lookup is by key_hash, which is unguessable.
 */
export async function resolveApiKey(
  svc: SupabaseClient<Database>,
  raw: string | null | undefined,
): Promise<ResolvedKey | null> {
  if (!raw || !looksLikeApiKey(raw)) return null;

  const hash = hashKey(raw);
  const { data, error } = await svc
    .from("api_keys")
    .select("id, workspace_id, key_hash, scopes, revoked_at")
    .eq("key_hash", hash)
    .is("revoked_at", null)
    .maybeSingle();

  if (error || !data) return null;
  // Defense-in-depth: re-verify the hash in constant time even though the WHERE
  // already matched it — guards against any future fuzzy-match drift.
  if (!hashesEqual(data.key_hash, hash)) return null;

  // Best-effort last-used stamp. Never block auth on this write.
  void svc
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id)
    .then(undefined, () => {});

  return { keyId: data.id, workspaceId: data.workspace_id, scopes: data.scopes ?? [] };
}
