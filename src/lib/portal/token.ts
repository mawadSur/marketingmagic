// ─────────────────────────────────────────────────────────────
// Client portal — token resolution (Phase D, migration 029)
// ─────────────────────────────────────────────────────────────
//
// SECURITY NOTE — read before touching this file.
//
// The /client/[token] surface is UNAUTHENTICATED: there is no auth.uid(), so
// RLS cannot protect it. Everything the portal can read or write is gated by
// exactly one thing — the workspace_id we resolve here from the raw token in
// the URL. If this resolver is wrong, the whole portal is wrong.
//
// Rules enforced here (the only place token validation lives):
//   1. The raw token is NEVER stored. We store SHA-256(raw) in
//      client_portal_tokens.token_hash and look the row up by that hash.
//   2. A token is valid only when revoked_at IS NULL and (expires_at IS NULL
//      OR expires_at > now). Both checks happen here, once.
//   3. Resolution yields a frozen { workspaceId, scopes, tokenId } context.
//      Callers in src/lib/portal/* must scope EVERY query to context.workspaceId
//      and gate writes on context.scopes — never trust the URL again downstream.
//
// We use the service-role client (RLS-bypassing by design) because there is no
// authenticated user. That is exactly why the workspace scoping below is the
// single security boundary and must never be omitted.

import crypto from "node:crypto";
import { supabaseService } from "@/lib/supabase/service";
import type { ClientPortalScope } from "@/lib/db/types";

// Resolved, validated portal session. Immutable: callers read workspaceId /
// scopes off this and pass it down — they must not re-derive workspace from
// anything else (e.g. a query param), which is how cross-workspace bugs creep
// in.
export interface PortalContext {
  readonly tokenId: string;
  readonly workspaceId: string;
  readonly scopes: readonly ClientPortalScope[];
  readonly label: string | null;
}

// Raw portal tokens are URL path segments. We accept a generous-but-bounded
// charset (base64url + hex) so a malformed/oversized path can't reach the DB
// hash lookup. Length cap also bounds the SHA input.
const RAW_TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/;

// Hash a raw token the same way the mint path does. SHA-256, lowercase hex.
// Keep this in lockstep with src/lib/portal/manage.ts hashToken().
export function hashToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/**
 * Resolve a raw portal token (from the URL) to a validated PortalContext, or
 * null when the token is malformed, unknown, revoked, or expired. Returning
 * null (never throwing) lets the route render a single generic "invalid link"
 * page without leaking which of those conditions failed.
 *
 * This is the ONLY function that maps a raw token to a workspace. Every portal
 * read/write must start from the context it returns.
 */
export async function resolvePortalToken(rawToken: string): Promise<PortalContext | null> {
  if (!RAW_TOKEN_RE.test(rawToken)) return null;

  const tokenHash = hashToken(rawToken);
  const svc = supabaseService();

  // Look up by hash only — never by raw token, which we don't store. Select
  // just the fields we need to validate + build the context.
  const { data, error } = await svc
    .from("client_portal_tokens")
    .select("id, workspace_id, scopes, label, expires_at, revoked_at")
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
    scopes: Object.freeze([...(data.scopes ?? [])]) as readonly ClientPortalScope[],
    label: data.label,
  });
}

// Hard scope gate. Throwing PortalScopeError (rather than returning false)
// forces callers to handle the unauthorized case — a missing scope must never
// silently fall through to a query.
export class PortalScopeError extends Error {
  constructor(public readonly scope: ClientPortalScope) {
    super(`Portal token is missing the '${scope}' scope.`);
    this.name = "PortalScopeError";
  }
}

export function hasScope(ctx: PortalContext, scope: ClientPortalScope): boolean {
  return ctx.scopes.includes(scope);
}

// Assert a scope or throw. Use at the top of every scope-gated DAL function so
// the gate lives next to the query it protects.
export function assertScope(ctx: PortalContext, scope: ClientPortalScope): void {
  if (!hasScope(ctx, scope)) throw new PortalScopeError(scope);
}
