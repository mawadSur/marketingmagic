import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";
import { generateKey, isApiScope, type ApiScope } from "@/lib/api/keys";

// ─── API-key management (cookie-authed UI path) ──────────────────────────────
//
// These run from the /settings/api-keys server actions using the COOKIE-authed
// client (supabaseServer), so RLS on api_keys (is_workspace_member) is the
// isolation boundary here — distinct from the API REQUEST path, which uses the
// service client and scopes in code (src/lib/api/context.ts).
//
// We pass workspace_id explicitly on every call anyway (defense in depth) so a
// caller can't accidentally manage another workspace's keys even if RLS were
// mis-scoped.

// Listing never includes key_hash — there is nothing secret to leak, and the
// raw key is unrecoverable by design.
export interface ApiKeyListItem {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  last_used_at: string | null;
  created_at: string;
}

export async function listApiKeys(
  svc: SupabaseClient<Database>,
  workspaceId: string,
): Promise<ApiKeyListItem[]> {
  const { data, error } = await svc
    .from("api_keys")
    .select("id, name, key_prefix, scopes, last_used_at, created_at")
    .eq("workspace_id", workspaceId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export interface CreatedApiKey {
  id: string;
  name: string;
  scopes: string[];
  /** The raw secret — returned to the caller ONCE. Never stored, never re-shown. */
  raw: string;
}

/**
 * Mint + persist a new API key for a workspace. Returns the raw secret exactly
 * once; only its hash is stored. Scopes are validated against the known set so
 * a typo'd scope can never be persisted (it would silently 403 every request).
 */
export async function createApiKey(
  svc: SupabaseClient<Database>,
  args: { workspaceId: string; name: string; scopes: string[]; createdBy: string | null },
): Promise<CreatedApiKey> {
  const name = args.name.trim();
  if (!name) throw new Error("A key name is required.");
  if (name.length > 80) throw new Error("Key name must be 80 characters or fewer.");

  // Drop unknown scopes loudly rather than persisting junk.
  const scopes: ApiScope[] = [];
  for (const s of args.scopes) {
    if (!isApiScope(s)) throw new Error(`Unknown scope: ${s}`);
    if (!scopes.includes(s)) scopes.push(s);
  }
  if (scopes.length === 0) throw new Error("Select at least one scope.");

  const key = generateKey();
  const { data, error } = await svc
    .from("api_keys")
    .insert({
      workspace_id: args.workspaceId,
      name,
      key_prefix: key.prefix,
      key_hash: key.hash,
      scopes,
      created_by: args.createdBy,
    })
    .select("id, name, scopes")
    .single();
  if (error) throw error;

  return { id: data.id, name: data.name, scopes: data.scopes ?? [], raw: key.raw };
}

/**
 * Soft-revoke a key (sets revoked_at). Workspace-scoped: the WHERE clause pins
 * both id AND workspace_id so a key from another workspace can't be revoked even
 * if its id is known. Returns true when a row was revoked.
 */
export async function revokeApiKey(
  svc: SupabaseClient<Database>,
  workspaceId: string,
  keyId: string,
): Promise<boolean> {
  const { data, error } = await svc
    .from("api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("id", keyId)
    .is("revoked_at", null)
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}
