import { supabaseService } from "@/lib/supabase/service";
import { tierFor, type PlanId } from "@/lib/billing/tiers";
import { getUsageSnapshot } from "@/lib/billing/usage";
import { resolvePlanForWorkspace } from "@/lib/billing/entitlements";

// Typed error so callers can `catch (err) { if (err instanceof QuotaExceededError) ... }`
// and surface an upgrade nudge instead of leaking the raw message. The
// `kind` distinguishes which quota tripped so the UI can deep-link the
// right CTA.
export type QuotaKind = "posts" | "images" | "channels" | "videos";

export class QuotaExceededError extends Error {
  readonly kind: QuotaKind;
  readonly plan: PlanId;
  readonly current: number;
  readonly limit: number;

  constructor(args: { kind: QuotaKind; plan: PlanId; current: number; limit: number; message?: string }) {
    super(
      args.message ??
        `You've hit your ${args.kind} quota for the ${args.plan} plan (${args.current} / ${args.limit}). Upgrade to continue.`,
    );
    this.name = "QuotaExceededError";
    this.kind = args.kind;
    this.plan = args.plan;
    this.current = args.current;
    this.limit = args.limit;
  }
}

// Resolves the plan that governs this workspace's quotas. Delegates to the
// entitlement resolver: solo workspaces use their own plan (unchanged), client
// workspaces of an org inherit the org's plan. See lib/billing/entitlements.ts.
async function getPlanForWorkspace(workspaceId: string): Promise<PlanId> {
  return resolvePlanForWorkspace(workspaceId);
}

export async function assertWithinPostQuota(workspaceId: string, requested = 1): Promise<void> {
  const plan = await getPlanForWorkspace(workspaceId);
  const baseLimit = tierFor(plan).limits.postsPerMonth;
  if (baseLimit === -1) return;
  // PLG referral reward (migration 030): bonus monthly posts earned by driving
  // signups are added on top of the tier ceiling. The bonus is a per-workspace
  // perk (read off the workspace row), not inherited from an org plan.
  const bonus = await getReferralBonusPosts(workspaceId);
  const limit = baseLimit + bonus;
  const usage = await getUsageSnapshot(workspaceId);
  if (usage.postsGenerated + requested > limit) {
    throw new QuotaExceededError({
      kind: "posts",
      plan,
      current: usage.postsGenerated,
      limit,
      message: `Generating ${requested} more post(s) would exceed your ${plan} plan limit of ${limit} per month. Upgrade in Settings → Billing.`,
    });
  }
}

// The referral bonus posts granted to this workspace (0 if none / row missing).
// Service-role read, mirroring the other quota lookups in this module.
async function getReferralBonusPosts(workspaceId: string): Promise<number> {
  const svc = supabaseService();
  const { data } = await svc
    .from("workspaces")
    .select("referral_bonus_posts")
    .eq("id", workspaceId)
    .maybeSingle();
  return data?.referral_bonus_posts ?? 0;
}

export async function assertWithinImageQuota(workspaceId: string, requested = 1): Promise<void> {
  const plan = await getPlanForWorkspace(workspaceId);
  const limit = tierFor(plan).limits.imageGensPerMonth;
  if (limit === -1) return;
  if (limit === 0) {
    throw new QuotaExceededError({
      kind: "images",
      plan,
      current: 0,
      limit: 0,
      message: `AI image generation is not included in the ${plan} plan. Upgrade in Settings → Billing.`,
    });
  }
  const usage = await getUsageSnapshot(workspaceId);
  if (usage.imagesGenerated + requested > limit) {
    throw new QuotaExceededError({
      kind: "images",
      plan,
      current: usage.imagesGenerated,
      limit,
      message: `You've used ${usage.imagesGenerated} / ${limit} AI images this month. Upgrade in Settings → Billing.`,
    });
  }
}

// P4: monthly cap on BYO-key video renders. Mirrors assertWithinImageQuota:
// a limit of 0 means the tier doesn't include video at all (Hobby), -1 means
// unlimited. Called from the orchestrator BEFORE the MPT POST so we never
// enqueue a render the workspace isn't entitled to.
export async function assertWithinVideoQuota(workspaceId: string, requested = 1): Promise<void> {
  const plan = await getPlanForWorkspace(workspaceId);
  const limit = tierFor(plan).limits.videosPerMonth;
  if (limit === -1) return;
  if (limit === 0) {
    throw new QuotaExceededError({
      kind: "videos",
      plan,
      current: 0,
      limit: 0,
      message: `Video generation is not included in the ${plan} plan. Upgrade in Settings → Billing.`,
    });
  }
  const usage = await getUsageSnapshot(workspaceId);
  if (usage.videosGenerated + requested > limit) {
    throw new QuotaExceededError({
      kind: "videos",
      plan,
      current: usage.videosGenerated,
      limit,
      message: `You've used ${usage.videosGenerated} / ${limit} video renders this month. Upgrade in Settings → Billing.`,
    });
  }
}

// Channel cap is structural (not monthly). Hobby is capped at 1 connected
// account. Called from connect flows BEFORE we insert a new social_account.
//
// Existing accounts are grandfathered — we only block NEW connections.
// If `reconnect` matches an existing (channel, handle) row in the workspace
// (i.e. the user is re-authorising the same account), we allow it through
// regardless of the cap. That keeps an over-cap hobby user able to refresh
// expired tokens on accounts they're already using.
export async function assertWithinChannelQuota(
  workspaceId: string,
  reconnect?: { channel: string; handle: string },
): Promise<void> {
  const plan = await getPlanForWorkspace(workspaceId);
  const limit = tierFor(plan).limits.channels;
  if (limit === -1) return;

  const svc = supabaseService();

  if (reconnect) {
    // Cast channel — the social_accounts.channel column is a constrained
    // text enum but `reconnect.channel` arrives as `string` from various
    // OAuth flows. Mismatched values just fail to match a row, which is
    // safe (we'd correctly enforce the cap on an unknown channel).
    const { data: existing } = await svc
      .from("social_accounts")
      .select("id")
      .eq("workspace_id", workspaceId)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .eq("channel", reconnect.channel as any)
      .eq("handle", reconnect.handle)
      .maybeSingle();
    if (existing) return; // Reconnect of a known account — always allowed.
  }

  // Count only live channels — a disconnected account no longer occupies a
  // quota slot, so the user can connect a different channel in its place.
  const { count } = await svc
    .from("social_accounts")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .neq("status", "disconnected");

  const current = count ?? 0;
  if (current >= limit) {
    throw new QuotaExceededError({
      kind: "channels",
      plan,
      current,
      limit,
      message: `The ${plan} plan allows ${limit} connected channel(s). Upgrade in Settings → Billing to add more.`,
    });
  }
}

// ─── Retroactive (SOFT) channel-cap enforcement ──────────────────────────────
//
// assertWithinChannelQuota above blocks NEW connects, but it does NOT cover a
// workspace that already has more connected channels than its plan allows — e.g.
// after a plan DOWNGRADE (Solo→Hobby, or a Stripe past_due→unpaid lapse that
// resolveEntitlement maps to 'hobby'), or accounts connected before the cap was
// enforced. Those over-limit channels must stay connected (non-destructive — we
// never wipe credentials) but be BLOCKED from publishing / auto-actions until the
// user upgrades or disconnects. This helper is the single source of truth for
// "which accounts are over the limit," reused by every enforcement point (the
// post dispatcher, the auto-reply gate, the DM-capture gate, and the channels UI).
//
// COMPUTED ON READ — no cached `over_limit` column, no migration. Rationale:
//   * The over-limit set is a pure function of (a) the workspace's EFFECTIVE plan
//     limit and (b) the created_at ordering of its live accounts. Nothing else.
//   * The effective limit can change WITHOUT any social_accounts write — most
//     importantly a Stripe subscription lapse (past_due → unpaid) flips the
//     effective plan to hobby via resolveEntitlement's subscription_status gate,
//     and NO social_accounts row is touched. A cached flag would silently drift
//     out of date in exactly the revenue-leak case we're closing here, unless we
//     also recomputed it from a dunning webhook — extra moving parts to keep in
//     sync. Computing on read makes the flag impossible to desync, and makes
//     upgrade re-activation FREE (the next read just sees the higher limit and
//     returns an empty over-limit set — no recompute step to remember to run).
//
// STABLE SELECTION — we keep the OLDEST N accounts (N = plan channel limit) ACTIVE
// and mark the rest over-limit, ordering by created_at ASC (ties broken by id ASC
// for determinism). Anchoring on age means the active set doesn't thrash between
// checks: connecting/disconnecting a channel, or a flapping subscription, never
// reshuffles which existing accounts are live. Unlimited plans (limit === -1)
// keep ALL accounts active → empty set.

type ServiceClient = ReturnType<typeof supabaseService>;

// One live account, reduced to the only fields the over-limit computation needs.
interface OverLimitCandidate {
  id: string;
  created_at: string;
}

// Pure core: given the live accounts (any order) and the effective channel
// limit, return the ids that fall BEYOND the limit. Exported for unit tests so
// the oldest-N-kept selection can be exercised without a DB. `limit === -1`
// (unlimited) → empty set; `live.length <= limit` (at or under) → empty set.
export function selectOverLimitIds(
  live: ReadonlyArray<OverLimitCandidate>,
  limit: number,
): Set<string> {
  if (limit === -1) return new Set();
  // Stable order: oldest first; id as a deterministic tiebreaker so two rows
  // sharing a created_at always sort the same way across calls.
  const ordered = [...live].sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  // Keep the first `limit` (oldest) active; everything after is over-limit.
  // A non-positive limit (shouldn't happen for a real tier, but be defensive)
  // marks every account over-limit.
  const keep = Math.max(limit, 0);
  return new Set(ordered.slice(keep).map((a) => a.id));
}

// The set of social_account ids in this workspace that are OVER the plan's
// connected-channel limit (and therefore blocked from publishing / auto-actions).
// Empty set for unlimited plans, for workspaces at or under the limit, and on any
// read error (fail-OPEN: a transient DB hiccup must never silently freeze a
// paying customer's whole publishing pipeline — the connect-time cap already
// bounds how many channels exist, so the blast radius of failing open is small).
export async function overLimitAccountIds(
  workspaceId: string,
  client?: ServiceClient,
): Promise<Set<string>> {
  const plan = await getPlanForWorkspace(workspaceId);
  const limit = tierFor(plan).limits.channels;
  if (limit === -1) return new Set();

  const svc = client ?? supabaseService();
  const { data, error } = await svc
    .from("social_accounts")
    .select("id, created_at")
    .eq("workspace_id", workspaceId)
    .neq("status", "disconnected")
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });

  if (error || !data) return new Set();
  return selectOverLimitIds(data, limit);
}

// Convenience single-account check used by the publish / auto-action gates,
// which already hold one account id. Thin wrapper over overLimitAccountIds so
// the oldest-N-kept logic lives in exactly one place.
export async function isAccountOverLimit(
  workspaceId: string,
  socialAccountId: string,
  client?: ServiceClient,
): Promise<boolean> {
  const overLimit = await overLimitAccountIds(workspaceId, client);
  return overLimit.has(socialAccountId);
}
