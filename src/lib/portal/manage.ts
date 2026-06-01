// ─────────────────────────────────────────────────────────────
// Client portal — token management (org-side, Phase D, migration 029)
// ─────────────────────────────────────────────────────────────
//
// This is the AUTHENTICATED side: agency staff mint/list/revoke portal tokens
// for a client workspace. Unlike src/lib/portal/data.ts (the unauthenticated
// portal trust boundary), callers here are real users and authorization is the
// caller's responsibility BEFORE invoking these — the server action that wraps
// them must first prove (via the RLS-backed authed client) that the user can
// see the target workspace. We then use the service role only to write the
// token rows.
//
// The raw token is generated here and returned to the caller exactly ONCE (so
// it can be shown / put in a link). Only its SHA-256 hash is persisted; we keep
// hashing in lockstep with src/lib/portal/token.ts hashToken().

import crypto from "node:crypto";
import { supabaseService } from "@/lib/supabase/service";
import { hashToken } from "@/lib/portal/token";
import type { ClientPortalScope, Database } from "@/lib/db/types";

type TokenRow = Database["public"]["Tables"]["client_portal_tokens"]["Row"];

// 32 bytes → 43-char base64url string. Comfortably inside token.ts's
// RAW_TOKEN_RE (16–256, base64url charset) and high-entropy.
export function generateRawToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export interface MintTokenInput {
  workspaceId: string;
  createdBy: string;
  label: string | null;
  scopes: ClientPortalScope[];
  expiresAt: string | null;
}

export interface MintTokenResult {
  rawToken: string;
  tokenId: string;
}

/**
 * Mint a new portal token for a workspace. Returns the RAW token once — the
 * caller must surface it immediately; it cannot be recovered later. Persists
 * only the hash. Authorization MUST be checked by the caller first.
 */
export async function mintPortalToken(input: MintTokenInput): Promise<MintTokenResult> {
  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);
  const svc = supabaseService();

  const { data, error } = await svc
    .from("client_portal_tokens")
    .insert({
      workspace_id: input.workspaceId,
      token_hash: tokenHash,
      label: input.label,
      scopes: input.scopes,
      expires_at: input.expiresAt,
      created_by: input.createdBy,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? "Failed to create portal link.");
  }
  return { rawToken, tokenId: data.id };
}

// Token row sans the hash — never surface the hash to the UI.
export type ManagedToken = Omit<TokenRow, "token_hash">;

/**
 * List portal tokens for a workspace (most recent first). Scoped to the given
 * workspace_id. Authorization MUST be checked by the caller first.
 */
export async function listPortalTokens(workspaceId: string): Promise<ManagedToken[]> {
  const svc = supabaseService();
  const { data } = await svc
    .from("client_portal_tokens")
    .select("id, workspace_id, label, scopes, expires_at, revoked_at, created_by, created_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });
  return (data ?? []) as ManagedToken[];
}

/**
 * Record a sent client-invite email for the audit trail (migration 035). Best-
 * effort: a write failure is logged and swallowed (returns the error string) so
 * a successful email send is never reported as a failure just because the audit
 * row didn't persist. Authorization MUST be checked by the caller first; the row
 * is scoped to (workspaceId, tokenId) the caller already proved it controls.
 */
export async function recordClientInvite(input: {
  workspaceId: string;
  tokenId: string | null;
  recipientEmail: string;
  createdBy: string;
}): Promise<{ error: string | null }> {
  const svc = supabaseService();
  const { error } = await svc.from("client_invites").insert({
    workspace_id: input.workspaceId,
    token_id: input.tokenId,
    recipient_email: input.recipientEmail,
    created_by: input.createdBy,
  });
  if (error) {
    console.error(
      `[portal-invite] audit insert failed for workspace ${input.workspaceId} ` +
        `(email was still sent): ${error.message}`,
    );
  }
  return { error: error?.message ?? null };
}

/**
 * Revoke a token. Scoped to BOTH the token id and the workspace_id so a caller
 * authorized for workspace A can never revoke workspace B's token by id.
 * Authorization MUST be checked by the caller first.
 */
export async function revokePortalToken(
  tokenId: string,
  workspaceId: string,
): Promise<{ error: string | null }> {
  const svc = supabaseService();
  const { error } = await svc
    .from("client_portal_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", tokenId)
    .eq("workspace_id", workspaceId)
    .is("revoked_at", null);
  return { error: error?.message ?? null };
}
