import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import { supabaseService } from "@/lib/supabase/service";
import { checkRateLimit } from "@/lib/rate-limit";
import { resolveApiKey } from "@/lib/api/keys";
import { WorkspaceApi } from "@/lib/api/context";
import {
  ApiError,
  missingApiKey,
  invalidApiKey,
  insufficientScope,
  rateLimited,
  type ApiErrorCode,
} from "@/lib/api/errors";

// ─── Public-API middleware ──────────────────────────────────────────────────
//
// withApiKey(requiredScope)(handler) wraps a v1 route with: bearer-key auth →
// scope check → per-key rate limit → a workspace-scoped WorkspaceApi handed to
// the handler. Every failure leaves through the same JSON envelope, tagged with
// a request_id that's also attached to the Sentry event for 500s. No route ever
// touches supabaseService() directly — they get the scoped `api` instead.

export type ApiHandler = (
  req: NextRequest,
  ctx: { api: WorkspaceApi; requestId: string; params: Record<string, string> },
) => Promise<NextResponse> | NextResponse;

// Per-key budget. Generous enough for automation, tight enough to bound abuse.
const RATE_LIMIT = 120; // requests
const RATE_WINDOW_MS = 60_000; // per minute

function envelope(
  code: ApiErrorCode,
  message: string,
  status: number,
  requestId: string,
  extra?: { details?: unknown; headers?: Record<string, string> },
): NextResponse {
  const body: Record<string, unknown> = { error: { code, message, request_id: requestId } };
  if (extra?.details !== undefined) (body.error as Record<string, unknown>).details = extra.details;
  const res = NextResponse.json(body, { status });
  res.headers.set("x-request-id", requestId);
  if (extra?.headers) for (const [k, v] of Object.entries(extra.headers)) res.headers.set(k, v);
  return res;
}

function bearerToken(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m ? m[1]!.trim() : null;
}

/**
 * Wrap a v1 route handler with auth + scope + rate limit + error handling.
 *
 * @param requiredScope - the scope this route needs (e.g. "posts:write"), or
 *   null for an authenticated-but-unscoped route.
 */
export function withApiKey(requiredScope: string | null) {
  return (handler: ApiHandler) => {
    return async (
      req: NextRequest,
      routeCtx?: { params?: Promise<Record<string, string>> },
    ): Promise<NextResponse> => {
      const requestId = `req_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      try {
        const token = bearerToken(req);
        if (!token) throw missingApiKey();

        const svc = supabaseService();
        const resolved = await resolveApiKey(svc, token);
        if (!resolved) throw invalidApiKey();

        // Rate-limit per key id (not per IP) — the key is the principal.
        const rl = await checkRateLimit("api-v1", resolved.keyId, RATE_LIMIT, RATE_WINDOW_MS);
        if (!rl.ok) throw rateLimited(Math.ceil(rl.resetMs / 1000));

        if (requiredScope && !resolved.scopes.includes(requiredScope)) {
          throw insufficientScope(requiredScope);
        }

        const api = new WorkspaceApi(resolved.workspaceId, resolved.scopes, svc);
        const params = routeCtx?.params ? await routeCtx.params : {};
        const res = await handler(req, { api, requestId, params });
        res.headers.set("x-request-id", requestId);
        // Surface remaining budget so well-behaved clients can self-throttle.
        res.headers.set("x-ratelimit-remaining", String(rl.remaining));
        return res;
      } catch (err) {
        if (err instanceof ApiError) {
          return envelope(err.code, err.message, err.status, requestId, {
            details: err.details,
            headers: err.headers,
          });
        }
        // Unknown error — never leak internals. Log with the request id so a
        // support report ("request_id: req_…") is traceable in Sentry.
        Sentry.captureException(err, { tags: { request_id: requestId, surface: "public-api" } });
        console.error(`[api-v1] ${requestId} unhandled:`, err);
        return envelope(
          "internal_error",
          "An unexpected error occurred. Quote the request_id when contacting support.",
          500,
          requestId,
        );
      }
    };
  };
}
