// PLG acquisition loop — shareable preview plans.
//
// The /start preview is normally stateless: the whole plan rides in a signed
// HMAC token in the URL (see lib/preview/token.ts), 24h TTL, no DB. That's
// perfect for the just-generated view, but a token URL is 2–4 KB of opaque
// base64 — ugly to paste into a tweet, and it ages out in a day. When a visitor
// hits "Share this plan" we instead PERSIST the preview content under a short,
// unguessable slug so they get a stable, social-unfurl-friendly link at
// /p/<slug> with a generous TTL.
//
// Security model — the slug IS the capability:
//   * preview_shares has RLS on with NO public policies, so PostgREST anon/auth
//     callers can't read or enumerate it. Reads + writes happen ONLY here,
//     through the service role, where possession of the (unguessable, 128-bit)
//     slug is the read grant. There is no list endpoint.
//   * The stored payload is preview content ONLY (channel, handle, plan, voice
//     summary) — the same data the anonymous visitor already saw before signing
//     up. No workspace id, user id, or account data ever touches this table, so
//     a leaked slug exposes nothing beyond the marketing preview itself.

import crypto from "node:crypto";
import type { PreviewSharePayload } from "@/lib/db/types";
import { supabaseService } from "@/lib/supabase/service";

// Shared links live longer than the 24h signed-token preview so they survive in
// someone's feed/DMs for a while, but still age out (a stale plan shouldn't
// linger forever). 90 days is a reasonable "social half-life" ceiling.
const SHARE_TTL_DAYS = 90;

// 24 chars from a URL-safe, no-ambiguous alphabet → ~124 bits of entropy:
// unguessable, so the slug alone is a safe read capability. Matches the column
// CHECK (^[a-zA-Z0-9_-]{8,40}$).
const SLUG_ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SLUG_LEN = 24;

function generateSlug(): string {
  let out = "";
  const bytes = crypto.randomBytes(SLUG_LEN);
  for (let i = 0; i < SLUG_LEN; i++) {
    out += SLUG_ALPHABET[bytes[i]! % SLUG_ALPHABET.length];
  }
  return out;
}

/** Cheap pre-DB validation of a raw /p/<slug> path segment. */
export function isValidShareSlug(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{8,40}$/.test(value);
}

/**
 * Persist a preview plan under a fresh unguessable slug and return it.
 * Service-role only. Retries on the (astronomically unlikely) slug collision.
 */
export async function createPreviewShare(payload: PreviewSharePayload): Promise<string> {
  const svc = supabaseService();
  const expiresAt = new Date(Date.now() + SHARE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = generateSlug();
    const { error } = await svc
      .from("preview_shares")
      .insert({ slug, payload, expires_at: expiresAt });
    if (!error) return slug;
    // Only a unique-slug collision is retryable; anything else is fatal.
    if (!error.message.toLowerCase().includes("duplicate")) {
      throw new Error(`Could not create share link: ${error.message}`);
    }
  }
  throw new Error("Could not allocate a share link. Please try again.");
}

/**
 * Read a shared preview by slug. Returns null for unknown, malformed, or
 * EXPIRED slugs (callers render a friendly not-found instead of leaking
 * whether a slug ever existed). Service-role read — the slug is the capability.
 */
export async function getPreviewShare(slug: string): Promise<PreviewSharePayload | null> {
  if (!isValidShareSlug(slug)) return null;
  const svc = supabaseService();
  const { data, error } = await svc
    .from("preview_shares")
    .select("payload, expires_at")
    .eq("slug", slug)
    .maybeSingle();
  if (error || !data) return null;
  if (data.expires_at && new Date(data.expires_at).getTime() <= Date.now()) return null;
  return data.payload as PreviewSharePayload;
}
