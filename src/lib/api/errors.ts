// Stable error contract for the public API. Every failure leaves through one
// of these classes so the HTTP envelope is consistent and clients can branch
// on `code` (never on prose `message`, which may change). No silent failures:
// unknown errors map to internal_error (500) + Sentry in the middleware.

export type ApiErrorCode =
  | "missing_api_key"
  | "invalid_api_key"
  | "insufficient_scope"
  | "rate_limited"
  | "validation_error"
  | "channel_not_connected"
  | "channel_over_limit"
  | "not_found"
  | "method_not_allowed"
  | "internal_error";

const STATUS: Record<ApiErrorCode, number> = {
  missing_api_key: 401,
  invalid_api_key: 401,
  insufficient_scope: 403,
  rate_limited: 429,
  validation_error: 422,
  channel_not_connected: 422,
  channel_over_limit: 422,
  not_found: 404,
  method_not_allowed: 405,
  internal_error: 500,
};

/**
 * A client-facing API error. The middleware catches these and renders the
 * stable JSON envelope; anything that is NOT an ApiError becomes internal_error
 * (500) and is reported to Sentry.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  /** Optional structured detail (e.g. Zod field issues) surfaced to the client. */
  readonly details?: unknown;
  /** Optional headers to merge onto the response (e.g. Retry-After on 429). */
  readonly headers?: Record<string, string>;

  constructor(
    code: ApiErrorCode,
    message: string,
    opts?: { details?: unknown; headers?: Record<string, string> },
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = STATUS[code];
    this.details = opts?.details;
    this.headers = opts?.headers;
  }
}

// ─── Convenience constructors (read at call sites like a vocabulary) ────────
export const missingApiKey = () =>
  new ApiError("missing_api_key", "Provide an API key via the Authorization: Bearer header.");

export const invalidApiKey = () =>
  new ApiError("invalid_api_key", "The API key is invalid or has been revoked.");

export const insufficientScope = (required: string) =>
  new ApiError("insufficient_scope", `This API key lacks the required scope: ${required}.`);

export const rateLimited = (retryAfterSec: number) =>
  new ApiError("rate_limited", "Rate limit exceeded. Slow down and retry.", {
    headers: { "Retry-After": String(Math.max(1, retryAfterSec)) },
  });

export const validationError = (message: string, details?: unknown) =>
  new ApiError("validation_error", message, { details });

export const channelNotConnected = (channel: string) =>
  new ApiError(
    "channel_not_connected",
    `No ${channel} channel is connected for this workspace.`,
  );

export const channelOverLimit = () =>
  new ApiError(
    "channel_over_limit",
    "This channel is over your plan's connected-channel limit. Upgrade, or disconnect another channel.",
  );

export const notFound = (what = "Resource") =>
  new ApiError("not_found", `${what} not found.`);

export const methodNotAllowed = () =>
  new ApiError("method_not_allowed", "HTTP method not allowed on this endpoint.");
