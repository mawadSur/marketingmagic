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

// ─────────────────────────────────────────────────────────────
// Client ACCOUNTS — link an invited email to a workspace on signup (037)
// ─────────────────────────────────────────────────────────────
//
// When a user with email E signs up (or confirms), we look for PENDING client
// invites addressed to E in client_invites (migration 035) and create a
// client_membership for each invited workspace. This is the bridge that turns
// "agency emailed a client a link" into "client has a real account scoped to
// that workspace's report".
//
// SECURITY + correctness:
//   • Service-role only (no auth.uid() at signup time for the membership write);
//     client_memberships has no authenticated INSERT policy, so this is the ONLY
//     way a membership is ever created — a client can never self-link.
//   • IDEMPOTENT: upsert on (user_id, workspace_id) so re-running (e.g. confirm
//     then login) never duplicates, and a user invited to N workspaces gets N
//     memberships. We dedupe workspace ids in code before writing.
//   • Email match is case-insensitive (emails are case-insensitive); we lower()
//     both sides. The invite's recipient_email is the agency-controlled value.
//   • Best-effort + fail-safe: a failure here NEVER blocks signup. The agency
//     can re-send the invite, or a later login re-runs the link.

export interface LinkClientResult {
  linkedWorkspaceIds: string[];
  error: string | null;
}

/**
 * Create client_memberships for every workspace `email` was invited to. Returns
 * the workspace ids linked (possibly empty when there are no pending invites for
 * this email — the normal case for an agency/solo signup). Never throws.
 */
export async function linkClientInvitesOnSignup(
  userId: string,
  email: string,
): Promise<LinkClientResult> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return { linkedWorkspaceIds: [], error: null };

  const svc = supabaseService();

  // Find pending invites addressed to this email. ilike with no wildcards is an
  // exact, case-insensitive match — invites are agency-written, so the value is
  // trusted; we still normalize to avoid case/whitespace misses.
  const { data: invites, error: readErr } = await svc
    .from("client_invites")
    .select("workspace_id")
    .ilike("recipient_email", normalized);

  if (readErr) {
    console.error(`[client-account] invite lookup failed for ${normalized}: ${readErr.message}`);
    return { linkedWorkspaceIds: [], error: readErr.message };
  }

  // Dedupe — an email may have been invited to the same workspace more than once
  // (multiple emails sent); each maps to ONE membership.
  const workspaceIds = Array.from(new Set((invites ?? []).map((i) => i.workspace_id)));
  if (workspaceIds.length === 0) return { linkedWorkspaceIds: [], error: null };

  // Idempotent upsert: unique(user_id, workspace_id) means a repeat run is a
  // no-op. ignoreDuplicates keeps it a pure insert-if-absent.
  const { error: writeErr } = await svc
    .from("client_memberships")
    .upsert(
      workspaceIds.map((workspace_id) => ({ user_id: userId, workspace_id })),
      { onConflict: "user_id,workspace_id", ignoreDuplicates: true },
    );

  if (writeErr) {
    console.error(`[client-account] membership upsert failed for ${userId}: ${writeErr.message}`);
    return { linkedWorkspaceIds: [], error: writeErr.message };
  }

  return { linkedWorkspaceIds: workspaceIds, error: null };
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
