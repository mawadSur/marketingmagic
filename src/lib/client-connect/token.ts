// ─────────────────────────────────────────────────────────────
// Client self-connect — token resolution (Agency Proof Engine, migration 044)
// ─────────────────────────────────────────────────────────────
//
// SECURITY NOTE — read before touching this file.
//
// The /connect/[token] surface is UNAUTHENTICATED: there is no auth.uid(), so
// RLS cannot protect it. The ONLY thing that scopes the OAuth connect this page
// drives is the workspace_id we resolve here from the raw token in the URL. If
// this resolver is wrong, a client could connect their channel to the wrong
// workspace. Modeled one-for-one on src/lib/portal/token.ts (resolvePortalToken)
// — same hashing, same revoke/expiry gates, same frozen-context discipline.
//
// Rules enforced here (the only place self-connect token validation lives):
//   1. The raw token is NEVER stored. We store SHA-256(raw) in
//      client_self_connect_tokens.token_hash and look the row up by that hash.
//   2. A token is valid only when revoked_at IS NULL and (expires_at IS NULL
//      OR expires_at > now). Both checks happen here, once.
//   3. Resolution yields a frozen { workspaceId, tokenId, label } context. The
//      initiate route must stamp ONLY context.workspaceId into the OAuth state —
//      never a value derived from the request.
//
// We use the service-role client (RLS-bypassing by design) because there is no
// authenticated user. That is exactly why the workspace scoping here is the
// single security boundary and must never be omitted.

import crypto from "node:crypto";
import { supabaseService } from "@/lib/supabase/service";
import type { Database } from "@/lib/db/types";

// Resolved, validated self-connect session. Immutable: the initiate route reads
// workspaceId off this and stamps it into the OAuth `state` — it must not
// re-derive the workspace from anything else (e.g. a query param).
export interface SelfConnectContext {
  readonly tokenId: string;
  readonly workspaceId: string;
  readonly label: string | null;
}

// Raw tokens are URL path segments. Same bounded charset as the portal resolver
// (base64url + hex) so a malformed/oversized path can't reach the DB hash
// lookup. Length cap also bounds the SHA input.
const RAW_TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/;

// Hash a raw token the same way the mint path does. SHA-256, lowercase hex.
// Keep this in lockstep with mintSelfConnectToken() below and with the portal's
// hashToken() — they all use the identical algorithm so the discipline is one
// thing to audit.
export function hashSelfConnectToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/**
 * Resolve a raw self-connect token (from the URL) to a validated context, or
 * null when the token is malformed, unknown, revoked, or expired. Returning
 * null (never throwing) lets the route render a single generic "invalid link"
 * page without leaking which condition failed.
 *
 * This is the ONLY function that maps a raw token to a workspace for the
 * self-connect path. The initiate route must start from the context it returns.
 */
export async function resolveSelfConnectToken(
  rawToken: string,
): Promise<SelfConnectContext | null> {
  if (!RAW_TOKEN_RE.test(rawToken)) return null;

  const tokenHash = hashSelfConnectToken(rawToken);
  const svc = supabaseService();

  // Look up by hash only — never by raw token, which we don't store.
  const { data, error } = await svc
    .from("client_self_connect_tokens")
    .select("id, workspace_id, label, expires_at, revoked_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (error || !data) return null;

  // Revocation is a hard gate.
  if (data.revoked_at !== null) return null;

  // Expiry is a hard gate. A null expires_at means "no expiry"; otherwise the
  // instant must still be in the future.
  if (data.expires_at !== null && Date.parse(data.expires_at) <= Date.now()) {
    return null;
  }

  return Object.freeze({
    tokenId: data.id,
    workspaceId: data.workspace_id,
    label: data.label,
  });
}

// ─────────────────────────────────────────────────────────────
// Mint / manage (org-side) — AUTHENTICATED. Authorization MUST be checked by
// the caller (a server action) BEFORE invoking these: prove via the RLS-backed
// authed client that the user can see the target client workspace. We then use
// the service role only to write the token rows. Mirrors src/lib/portal/manage.ts.
// ─────────────────────────────────────────────────────────────

// 32 bytes → 43-char base64url string. Comfortably inside RAW_TOKEN_RE and
// high-entropy.
export function generateRawSelfConnectToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

// Default lifetime for a self-connect link: long enough for a client to get
// around to it, short enough to limit exposure. The agency can mint a fresh one.
export const SELF_CONNECT_DEFAULT_TTL_DAYS = 14;

export interface MintSelfConnectInput {
  workspaceId: string;
  createdBy: string;
  label: string | null;
  expiresAt: string | null;
}

export interface MintSelfConnectResult {
  rawToken: string;
  tokenId: string;
}

/**
 * Mint a new self-connect token for a client workspace. Returns the RAW token
 * once — the caller must surface it immediately; it cannot be recovered later.
 * Persists only the hash. Authorization MUST be checked by the caller first.
 */
export async function mintSelfConnectToken(
  input: MintSelfConnectInput,
): Promise<MintSelfConnectResult> {
  const rawToken = generateRawSelfConnectToken();
  const tokenHash = hashSelfConnectToken(rawToken);
  const svc = supabaseService();

  const { data, error } = await svc
    .from("client_self_connect_tokens")
    .insert({
      workspace_id: input.workspaceId,
      token_hash: tokenHash,
      label: input.label,
      expires_at: input.expiresAt,
      created_by: input.createdBy,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? "Failed to create self-connect link.");
  }
  return { rawToken, tokenId: data.id };
}

// A self-connect token row sans the hash — never surface the hash to the UI.
// Mirrors ManagedToken in src/lib/portal/manage.ts (this table has no `scopes`).
type SelfConnectTokenRow =
  Database["public"]["Tables"]["client_self_connect_tokens"]["Row"];
export type ManagedSelfConnectToken = Omit<SelfConnectTokenRow, "token_hash">;

/**
 * List self-connect tokens for a workspace (most recent first). Scoped to the
 * given workspace_id. Authorization MUST be checked by the caller first. Mirrors
 * listPortalTokens in src/lib/portal/manage.ts — read-only, the hash is never
 * selected.
 */
export async function listSelfConnectTokens(
  workspaceId: string,
): Promise<ManagedSelfConnectToken[]> {
  const svc = supabaseService();
  const { data } = await svc
    .from("client_self_connect_tokens")
    .select("id, workspace_id, label, expires_at, revoked_at, created_by, created_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });
  return (data ?? []) as ManagedSelfConnectToken[];
}

/**
 * Revoke a self-connect token. Scoped to BOTH the token id and the workspace_id
 * so a caller authorized for workspace A can never revoke workspace B's token by
 * id. Authorization MUST be checked by the caller first.
 */
export async function revokeSelfConnectToken(
  tokenId: string,
  workspaceId: string,
): Promise<{ error: string | null }> {
  const svc = supabaseService();
  const { error } = await svc
    .from("client_self_connect_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", tokenId)
    .eq("workspace_id", workspaceId)
    .is("revoked_at", null);
  return { error: error?.message ?? null };
}
