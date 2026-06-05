// Plan-generated UGC avatar videos — per-channel opt-in kickoff.
//
// PARALLEL to plan-videos.ts but for the UGC (Higgsfield talking-avatar) path.
// When a plan is generated, the user may tick "Generate UGC avatar video" on any
// selected channel that is video-capable AND for which the workspace has a saved
// avatar + a Higgsfield key. For every inserted plan post on an opted-in channel
// we PRE-POPULATE a Higgsfield reference-video render from the post copy + the
// workspace's chosen avatar (via buildUgcRenderInput) and fire it through
// startReferenceVideoRender — so the user just APPROVES the resulting draft.
//
// Same two hard contracts as plan-videos.ts, both enforced here:
//   1. BEST-EFFORT — a render kickoff failure must NEVER block the plan or its
//      text posts from saving. Every startReferenceVideoRender call is wrapped
//      in try/catch; failures are logged and skipped.
//   2. QUOTA-BOUNDED — UGC renders meter the SAME monthly video allowance as the
//      MPT path (startReferenceVideoRender calls assertWithinVideoQuota +
//      incrementVideosGenerated). We compute the remaining allowance ONCE
//      (reusing remainingVideoQuota from plan-videos.ts — NOT duplicated here)
//      and cap the number of kickoffs to it, stopping the moment
//      startReferenceVideoRender throws QuotaExceededError.
//
// The rendered video attaches to the EXISTING plan post: startReferenceVideoRender
// → createJob persists the job, and the poll-video-jobs cron attaches the result.

import { QuotaExceededError } from "@/lib/billing/limits";
import { isVideoEligibleChannel } from "@/lib/video/plan-videos";
import { startReferenceVideoRender as defaultStartReferenceVideoRender } from "@/lib/video/orchestrator";
import { buildUgcRenderInput, isUgcEligible, type UgcAvatar, type UgcPlanTarget } from "@/lib/video/ugc-plan";

// Re-export remainingVideoQuota from plan-videos.ts so callers can pull the same
// quota helper from a single import without us re-implementing (or drifting) it.
export { remainingVideoQuota } from "@/lib/video/plan-videos";

// Parse the per-channel `ugc_<accountId>="on"` checkboxes off the plan form.
// Returns the SET of accountIds the user opted into a UGC avatar video for.
// Pure — no I/O, so the parse is unit-testable in isolation. Mirrors
// parseVideoOptIns but on the `ugc_` prefix (the two opt-ins are independent:
// a channel can have a stock-footage video, a UGC video, both, or neither).
export function parseUgcOptIns(formData: {
  entries(): IterableIterator<[string, FormDataEntryValue]>;
}): Set<string> {
  const out = new Set<string>();
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("ugc_")) continue;
    if (value !== "on") continue;
    out.add(key.slice("ugc_".length));
  }
  return out;
}

// Should THIS post get a UGC avatar video? True only when UGC is available on the
// workspace (avatar + key present, applied by the caller via `ugcAvailable`), the
// post's account was opted-in, and the channel is video-capable. Mirrors
// shouldGenerateVideoForPost so the force-pending-approval predicate and the
// kickoff target list can never drift apart.
export function shouldGenerateUgcForPost(args: {
  ugcAvailable: boolean;
  optedInAccountIds: ReadonlySet<string>;
  socialAccountId: string;
  channel: string;
}): boolean {
  if (!args.ugcAvailable) return false;
  if (!args.optedInAccountIds.has(args.socialAccountId)) return false;
  return isVideoEligibleChannel(args.channel);
}

export interface KickoffPlanUgcVideosResult {
  attempted: number;
  started: number;
  failed: number;
  // True once the remaining quota is exhausted (cap reached or QuotaExceededError
  // thrown). The caller can use this for logging; the plan still saves regardless.
  quotaExhausted: boolean;
}

// Fire a best-effort Higgsfield UGC render for each target, capped by `remaining`.
// Each target's render input is PRE-POPULATED by buildUgcRenderInput from the post
// copy + the workspace's chosen avatar (the same avatar for every post in the run),
// so the user only approves the resulting drafts. `consentBy` is the acting user's
// id — opting the plan into UGC with a chosen, owned avatar IS the consent
// attestation (buildUgcRenderInput sets consent: true).
//
// Stops early when the cap is hit OR startReferenceVideoRender throws
// QuotaExceededError. Targets that aren't UGC-eligible (empty copy, or a missing
// avatar) are skipped without consuming an attempt. Every other failure is
// swallowed (logged) so the plan save is never blocked.
//
// `startReferenceVideoRender` is injected (defaults to the real orchestrator)
// purely so the failure-isolation + quota-cap behaviour is unit-testable without
// hitting Higgsfield.
export async function kickoffPlanUgcVideos(
  workspaceId: string,
  targets: UgcPlanTarget[],
  avatar: UgcAvatar,
  remaining: number,
  consentBy: string | null,
  deps: { startReferenceVideoRender?: typeof defaultStartReferenceVideoRender } = {},
): Promise<KickoffPlanUgcVideosResult> {
  const start = deps.startReferenceVideoRender ?? defaultStartReferenceVideoRender;
  const result: KickoffPlanUgcVideosResult = {
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
    // Skip posts with nothing for the avatar to say (empty copy) or a bad avatar —
    // these don't consume an attempt or quota; the post still saves as text.
    if (!isUgcEligible(t, avatar)) continue;

    result.attempted += 1;
    try {
      const input = buildUgcRenderInput(t, avatar, { consentBy });
      await start(workspaceId, input);
      result.started += 1;
      budget -= 1;
    } catch (err) {
      // Quota tripped mid-loop (startReferenceVideoRender asserts per call) — stop
      // trying the rest; they'd only throw too. The plan + its text posts still save.
      if (err instanceof QuotaExceededError) {
        result.quotaExhausted = true;
        break;
      }
      // Any other failure (Higgsfield down, missing key, transport) is isolated to
      // this one post: log and move on. NEVER rethrow — the plan must persist.
      result.failed += 1;
      console.warn(
        `Plan UGC kickoff failed for post ${t.postId} (${t.channel}); skipping:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return result;
}
