// Plan-generated videos — per-channel opt-in kickoff.
//
// When a plan is generated, the user may tick "Generate a short video for each
// post" on any selected channel that is video-capable AND for which the
// workspace's BYO video keys are configured. For every inserted plan post on an
// opted-in channel we fire an MPT topic→stock-footage render (the existing
// startVideoRender path) whose video_subject = the idea theme/label and
// video_script = the post's text, so MPT narrates that exact copy.
//
// Two hard contracts, both enforced here:
//   1. BEST-EFFORT — a render kickoff failure must NEVER block the plan or its
//      text posts from saving. Every startVideoRender call is wrapped in
//      try/catch; failures are logged and skipped.
//   2. QUOTA-BOUNDED — we compute the workspace's remaining monthly video
//      allowance ONCE and cap the number of kickoffs to it. startVideoRender
//      itself asserts+increments quota per call, so we also stop the loop the
//      moment it throws QuotaExceededError (defence in depth against a race).
//
// The rendered video attaches to the EXISTING plan post (not a new draft): we
// pass postId through to startVideoRender → createJob → video_jobs.post_id, and
// the poll-video-jobs cron's attachDraftPost UPDATEs that post's media[] when
// job.post_id is set.

import { QuotaExceededError } from "@/lib/billing/limits";
import { tierFor } from "@/lib/billing/tiers";
import { getUsageSnapshot } from "@/lib/billing/usage";
import { channelSpec } from "@/lib/channels/registry";
import { startVideoRender as defaultStartVideoRender } from "@/lib/video/orchestrator";

// A single inserted plan post that may receive a video. The caller (the plan
// action) assembles these AFTER the posts insert so we have real post ids.
export interface PlanVideoTarget {
  // The inserted post's id — flows to video_jobs.post_id so the cron updates
  // THIS post's media instead of minting a new draft.
  postId: string;
  // Destination channel account — flows to video_jobs.social_account_id.
  socialAccountId: string;
  // The channel id (e.g. "x", "linkedin") — used to confirm supportsVideo.
  channel: string;
  // MPT video_subject: the idea theme/label that seeds stock-footage search.
  videoSubject: string;
  // MPT video_script: the post's exact copy, so the render narrates it.
  videoScript: string;
}

// Parse the per-channel `video_<accountId>="on"` checkboxes off the plan form.
// Returns the SET of accountIds the user opted into a video for. Pure — no I/O,
// so the parse is unit-testable in isolation.
export function parseVideoOptIns(formData: {
  entries(): IterableIterator<[string, FormDataEntryValue]>;
}): Set<string> {
  const out = new Set<string>();
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("video_")) continue;
    if (value !== "on") continue;
    out.add(key.slice("video_".length));
  }
  return out;
}

// Whether a given channel can receive a plan video at all. A channel is
// eligible ONLY when its registry spec marks supportsVideo. The keys/availability
// gate (mptConfigured && byoKeysConfigured && llm+pexels present) is applied by
// the caller via `videoAvailable` — we keep that single boolean here so the
// gating reads in one place.
export function isVideoEligibleChannel(channel: string): boolean {
  return channelSpec(channel)?.supportsVideo === true;
}

// Should THIS post get a video? True only when video is available on the
// deployment/workspace, the post's account was opted-in, and the channel is
// video-capable. Used both to force pending_approval at insert time AND to
// build the kickoff target list — same predicate, so the two never drift.
export function shouldGenerateVideoForPost(args: {
  videoAvailable: boolean;
  optedInAccountIds: ReadonlySet<string>;
  socialAccountId: string;
  channel: string;
}): boolean {
  if (!args.videoAvailable) return false;
  if (!args.optedInAccountIds.has(args.socialAccountId)) return false;
  return isVideoEligibleChannel(args.channel);
}

// Remaining video renders this workspace may start this month. Computed ONCE up
// front so the kickoff loop has a hard cap independent of startVideoRender's own
// per-call assertion. -1 (unlimited tier) → Number.POSITIVE_INFINITY; a 0 limit
// or an exhausted allowance → 0 (skip silently).
export async function remainingVideoQuota(
  workspaceId: string,
  plan: string | null | undefined,
): Promise<number> {
  const limit = tierFor(plan).limits.videosPerMonth;
  if (limit === -1) return Number.POSITIVE_INFINITY;
  if (limit === 0) return 0;
  const usage = await getUsageSnapshot(workspaceId);
  return Math.max(0, limit - usage.videosGenerated);
}

export interface KickoffPlanVideosResult {
  attempted: number;
  started: number;
  failed: number;
  // True once the remaining quota is exhausted (cap reached or QuotaExceededError
  // thrown). The caller can use this for logging; the plan still saves regardless.
  quotaExhausted: boolean;
}

// Fire a best-effort MPT render for each target, capped by `remaining`. Stops
// early when the cap is hit OR startVideoRender throws QuotaExceededError. Every
// other failure is swallowed (logged) so the plan save is never blocked.
//
// `startVideoRender` is injected (defaults to the real orchestrator) purely so
// the failure-isolation + quota-cap behaviour is unit-testable without MPT.
export async function kickoffPlanVideos(
  workspaceId: string,
  targets: PlanVideoTarget[],
  remaining: number,
  deps: { startVideoRender?: typeof defaultStartVideoRender } = {},
): Promise<KickoffPlanVideosResult> {
  const start = deps.startVideoRender ?? defaultStartVideoRender;
  const result: KickoffPlanVideosResult = {
    attempted: 0,
    started: 0,
    failed: 0,
    quotaExhausted: remaining <= 0,
  };
  if (targets.length === 0 || remaining <= 0) return result;

  let budget = remaining;
  for (const t of targets) {
    if (budget <= 0) {
      result.quotaExhausted = true;
      break;
    }
    result.attempted += 1;
    try {
      await start(workspaceId, {
        videoSubject: t.videoSubject,
        videoScript: t.videoScript,
        videoAspect: "9:16",
        socialAccountId: t.socialAccountId,
        postId: t.postId,
        videoCount: 1,
      });
      result.started += 1;
      budget -= 1;
    } catch (err) {
      // Quota tripped mid-loop (startVideoRender asserts per call) — stop trying
      // the rest; they'd only throw too. The plan + its text posts still save.
      if (err instanceof QuotaExceededError) {
        result.quotaExhausted = true;
        break;
      }
      // Any other failure (MPT down, missing keys, transport) is isolated to
      // this one post: log and move on. NEVER rethrow — the plan must persist.
      result.failed += 1;
      console.warn(
        `Plan video kickoff failed for post ${t.postId} (${t.channel}); skipping:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return result;
}
