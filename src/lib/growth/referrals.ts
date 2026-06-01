// PLG loop, first slice — referral program (invite → reward).
//
// Three concerns live here so the server actions stay thin:
//   1. CODE MINTING       — one stable, URL-safe code per workspace, created
//      lazily the first time the owner opens /settings/referrals.
//   2. REF-COOKIE CAPTURE  — the ?ref=<code> a visitor arrives with is stashed
//      in an HTTP-only cookie at signup, so it survives the Supabase
//      email-confirmation round trip (signup → email → callback → onboarding)
//      and is read back when the FIRST workspace is created.
//   3. ATTRIBUTION + REWARD — on workspace creation, if a valid pending ref
//      cookie resolves to a DIFFERENT workspace's code, we insert a referrals
//      row (UNIQUE on referred_workspace_id makes it idempotent) and bump the
//      referrer's referral_bonus_posts. The bonus is added to the tier ceiling
//      in assertWithinPostQuota (see lib/billing/limits.ts).
//
// All writes go through the SERVICE ROLE — referral_codes / referrals have no
// public write policy, so a user can't mint codes or fake a referral to farm
// bonus quota (mirrors usage_counters being service-role-only writable).

import crypto from "node:crypto";
import { cookies } from "next/headers";
import { supabaseService } from "@/lib/supabase/service";

// The cookie the ?ref code rides in from signup to workspace creation. HTTP-only
// so client JS can't tamper with it; short TTL because attribution should
// happen within one onboarding session, not weeks later.
export const REF_COOKIE = "mm_ref";
const REF_COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

// Bonus monthly posts granted to the referrer per successful referral. Small +
// finite: enough to feel rewarding (50% of the hobby ceiling) without turning
// referrals into an unbounded free-post faucet. Read by assertWithinPostQuota.
export const REFERRAL_BONUS_POSTS = 5;

// Codes are case-insensitively unique (a functional index enforces it) and must
// match the column CHECK: 6–16 alphanumerics. We generate 8 chars from a
// no-ambiguous-characters alphabet (no 0/O/1/l/I) so a code is easy to read and
// retype off a screenshot.
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const CODE_LEN = 8;
const REF_PARAM_RE = /^[a-zA-Z0-9]{6,16}$/;

function generateCode(): string {
  let out = "";
  const bytes = crypto.randomBytes(CODE_LEN);
  for (let i = 0; i < CODE_LEN; i++) {
    out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return out;
}

/**
 * Return the workspace's stable invite code, minting one on first call.
 * Idempotent: concurrent first-opens race on the UNIQUE(workspace_id)
 * constraint and we re-read the winner. Service-role only.
 */
export async function getOrCreateReferralCode(workspaceId: string): Promise<string> {
  const svc = supabaseService();

  const { data: existing } = await svc
    .from("referral_codes")
    .select("code")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (existing?.code) return existing.code;

  // Retry a few times in the (astronomically unlikely) event of a code
  // collision on the UNIQUE(code) / lower(code) indexes.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    const { error } = await svc
      .from("referral_codes")
      .insert({ workspace_id: workspaceId, code });
    if (!error) return code;

    // Another request minted this workspace's code first — re-read the winner.
    const { data: winner } = await svc
      .from("referral_codes")
      .select("code")
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (winner?.code) return winner.code;
    // Otherwise it was a code collision: loop and try a fresh code.
  }
  throw new Error("Could not allocate a referral code. Please try again.");
}

/** How many signups this workspace's code has driven. */
export async function countReferrals(workspaceId: string): Promise<number> {
  const svc = supabaseService();
  const { count } = await svc
    .from("referrals")
    .select("id", { count: "exact", head: true })
    .eq("referrer_workspace_id", workspaceId);
  return count ?? 0;
}

// ─── ref-cookie capture ──────────────────────────────────────────────────

/** Validate a raw ?ref value against the code format (cheap pre-DB check). */
export function isValidRefParam(value: string | null | undefined): value is string {
  return typeof value === "string" && REF_PARAM_RE.test(value);
}

/**
 * Stash a ?ref code in the HTTP-only cookie so it survives the
 * email-confirmation round trip. No-op on a malformed value.
 */
export async function setPendingRefCookie(code: string): Promise<void> {
  if (!isValidRefParam(code)) return;
  const jar = await cookies();
  jar.set(REF_COOKIE, code, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: REF_COOKIE_MAX_AGE,
  });
}

async function readPendingRefCookie(): Promise<string | null> {
  const jar = await cookies();
  const raw = jar.get(REF_COOKIE)?.value;
  return isValidRefParam(raw) ? raw : null;
}

async function clearPendingRefCookie(): Promise<void> {
  const jar = await cookies();
  jar.delete(REF_COOKIE);
}

// ─── attribution + reward ────────────────────────────────────────────────

/**
 * Attribute a freshly-created workspace to a referrer if a valid pending ref
 * cookie is present. Idempotent and safe to call unconditionally from the
 * workspace-creation action:
 *   - no cookie / unknown code / self-referral → silent no-op
 *   - already-attributed workspace → no-op (UNIQUE on referred_workspace_id)
 * On a real attribution we insert the referrals row and bump the referrer's
 * referral_bonus_posts. Never throws — a growth side-effect must not break
 * onboarding; failures are swallowed and the cookie is cleared regardless.
 */
export async function attributeWorkspaceCreation(referredWorkspaceId: string): Promise<void> {
  let code: string | null = null;
  try {
    code = await readPendingRefCookie();
    if (!code) return;

    const svc = supabaseService();
    const { data: referrer } = await svc
      .from("referral_codes")
      .select("workspace_id")
      .ilike("code", code)
      .maybeSingle();

    // Unknown code, or the user is using their own workspace's code → no-op.
    if (!referrer || referrer.workspace_id === referredWorkspaceId) return;

    const { error: insErr } = await svc.from("referrals").insert({
      referrer_workspace_id: referrer.workspace_id,
      referred_workspace_id: referredWorkspaceId,
      code,
    });
    // A duplicate means this workspace was already attributed — leave the prior
    // referral (and its reward) intact and don't double-credit.
    if (insErr) return;

    await grantReferralBonus(referrer.workspace_id);
  } catch {
    // Growth side-effect: never surface to the onboarding flow.
  } finally {
    // Always clear so a stale ref can't re-attribute a later workspace.
    await clearPendingRefCookie();
  }
}

/**
 * Add REFERRAL_BONUS_POSTS to the referrer's running bonus. Read-then-write
 * (no transaction) mirrors usage.ts/bumpCounter — the worst-case race loses a
 * single grant, acceptable for a growth perk.
 */
async function grantReferralBonus(referrerWorkspaceId: string): Promise<void> {
  const svc = supabaseService();
  const { data: ws } = await svc
    .from("workspaces")
    .select("referral_bonus_posts")
    .eq("id", referrerWorkspaceId)
    .maybeSingle();
  const next = (ws?.referral_bonus_posts ?? 0) + REFERRAL_BONUS_POSTS;
  await svc
    .from("workspaces")
    .update({ referral_bonus_posts: next })
    .eq("id", referrerWorkspaceId);
}
