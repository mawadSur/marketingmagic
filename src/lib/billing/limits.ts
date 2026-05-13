import { supabaseService } from "@/lib/supabase/service";
import { tierFor, type PlanId } from "@/lib/billing/tiers";
import { getUsageSnapshot } from "@/lib/billing/usage";

// Typed error so callers can `catch (err) { if (err instanceof QuotaExceededError) ... }`
// and surface an upgrade nudge instead of leaking the raw message. The
// `kind` distinguishes which quota tripped so the UI can deep-link the
// right CTA.
export type QuotaKind = "posts" | "images" | "channels";

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

async function getPlanForWorkspace(workspaceId: string): Promise<PlanId> {
  const svc = supabaseService();
  const { data } = await svc
    .from("workspaces")
    .select("plan")
    .eq("id", workspaceId)
    .maybeSingle();
  // Default to hobby if the row is missing (shouldn't happen for an
  // authenticated workspace, but be defensive).
  return (data?.plan as PlanId | undefined) ?? "hobby";
}

export async function assertWithinPostQuota(workspaceId: string, requested = 1): Promise<void> {
  const plan = await getPlanForWorkspace(workspaceId);
  const limit = tierFor(plan).limits.postsPerMonth;
  if (limit === -1) return;
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

  const { count } = await svc
    .from("social_accounts")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId);

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
