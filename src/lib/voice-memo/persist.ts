// Persist a generated voice-memo plan + posts.
//
// Extracted from src/app/(app)/record/generate-action.ts so that file stays
// under the 500-line ceiling and the plan+posts fan-out — which is verbatim
// the same shape as /sources/[id]/actions.ts — has one home rather than two.
//
// What it does (behaviour is IDENTICAL to the old inline block, with the one
// addition of the `voice_memo: true` metadata stamp):
//   1. Insert a posting_plans row.
//   2. Flatten the planner's `ideas[]` (or legacy `posts[]`) into per-channel
//      post payloads, applying the voice_score / trust-mode / max-chars rules.
//   3. Stamp every post with `source_id` (the voice-memo source) and a
//      `voice_memo: true` flag in generation_metadata so analytics can split
//      engagement on voice-memo vs typed sources without a second JOIN.
//   4. Best-effort increment of the per-workspace post usage counter.
//
// Returns the new plan id on success, or an error message. The caller
// redirects to /plans/[id] on success.

import { supabaseService } from "@/lib/supabase/service";
import { channelSpec } from "@/lib/channels/registry";
import { gateBatchForDedup } from "@/lib/dedup/gate";
import { incrementPostsGenerated } from "@/lib/billing/usage";
import type { PlanGenResult } from "@/lib/plan/generate";
import type { Database, Json } from "@/lib/db/types";

// Posts scoring below this voice_score are flagged low_confidence (and so
// never auto-scheduled) when the workspace has a voice profile. Mirrors the
// threshold in /sources/[id]/actions.ts and /plans/new.
export const VOICE_SCORE_THRESHOLD = 70;

// Minimal account shape the fan-out needs. Sourced from social_accounts_safe
// (id, channel, handle, trust_mode); trust_mode typed nullable to tolerate
// the narrowed select without a cast.
export interface PersistAccount {
  id: string;
  channel: string;
  handle: string;
  trust_mode: boolean | null;
}

export interface PersistVoiceMemoPlanArgs {
  workspaceId: string;
  sourceId: string;
  parentPlanId: string | null;
  brief: Database["public"]["Tables"]["brand_briefs"]["Row"];
  accounts: PersistAccount[];
  result: PlanGenResult;
}

export type PersistResult =
  | { ok: true; planId: string; skipped: string[] }
  | { ok: false; error: string };

type PostInsert = Database["public"]["Tables"]["posts"]["Insert"];

// Flattened, pre-fan-out post idea. Channel is the raw planner enum string.
interface FlatVariant {
  channel: string;
  text: string;
  theme: string;
  suggested_scheduled_at: string;
  rationale: string;
  image_prompt?: string;
  idea_id: string | null;
  idea_label: string | null;
  voice_score?: number;
}

// Pure: flatten the generated plan's ideas[] (or legacy posts[]) into a flat
// list of channel variants, dropping variants the model marked skip:true.
// Exported for unit testing.
export function flattenPlanVariants(plan: PlanGenResult["plan"]): FlatVariant[] {
  if (plan.ideas) {
    return plan.ideas.flatMap((idea) => {
      const ideaId = crypto.randomUUID();
      return idea.variants
        .filter((v) => !v.skip)
        .map((v) => ({
          channel: v.channel,
          text: v.text,
          theme: idea.theme,
          suggested_scheduled_at: idea.suggested_scheduled_at,
          rationale: v.rationale,
          image_prompt: v.image_prompt,
          idea_id: ideaId,
          idea_label: idea.idea_label,
          voice_score: v.voice_score,
        }));
    });
  }
  return (plan.posts ?? []).map((p) => ({
    channel: p.channel,
    text: p.text,
    theme: p.theme,
    suggested_scheduled_at: p.suggested_scheduled_at,
    rationale: p.rationale,
    image_prompt: p.image_prompt,
    idea_id: null,
    idea_label: null,
    voice_score: p.voice_score,
  }));
}

export interface BuildPostsResult {
  posts: PostInsert[];
  skipped: string[];
}

// Pure: turn flattened variants into post Insert rows, applying the
// voice_score / trust-mode / max-chars rules and stamping source_id +
// voice_memo metadata. Variants whose channel isn't connected are skipped
// (and reported in `skipped`). Exported for unit testing.
export function buildVoiceMemoPosts(opts: {
  variants: FlatVariant[];
  accounts: PersistAccount[];
  planId: string;
  workspaceId: string;
  sourceId: string;
  hasVoiceProfile: boolean;
  cacheReadInputTokens: number;
}): BuildPostsResult {
  const accountByChannel = new Map<string, PersistAccount>();
  for (const a of opts.accounts) accountByChannel.set(a.channel, a);

  const skipped: string[] = [];
  const posts = opts.variants.flatMap<PostInsert>((p) => {
    const acct = accountByChannel.get(p.channel);
    if (!acct) {
      skipped.push(p.channel);
      return [];
    }
    const voiceScore = typeof p.voice_score === "number" ? p.voice_score : null;
    const lowConfidence =
      opts.hasVoiceProfile && voiceScore !== null && voiceScore < VOICE_SCORE_THRESHOLD;
    const trusted = acct.trust_mode === true && !lowConfidence;
    const max = channelSpec(acct.channel)?.maxChars ?? 280;
    const text = p.text.length > max ? p.text.slice(0, max - 1) + "…" : p.text;

    return [
      {
        workspace_id: opts.workspaceId,
        plan_id: opts.planId,
        social_account_id: acct.id,
        channel: acct.channel as PostInsert["channel"],
        text,
        theme: p.theme,
        scheduled_at: p.suggested_scheduled_at,
        status: trusted ? "scheduled" : "pending_approval",
        voice_score: voiceScore,
        low_confidence: lowConfidence,
        idea_id: p.idea_id,
        source_id: opts.sourceId,
        generation_metadata: {
          rationale: p.rationale,
          cache_read_input_tokens: opts.cacheReadInputTokens,
          auto_scheduled: trusted,
          image_prompt: p.image_prompt ?? null,
          idea_label: p.idea_label,
          source_id: opts.sourceId,
          // Tag the persistence path so analytics can distinguish voice-memo-
          // anchored posts from URL/paste-anchored ones. `origin` kept for
          // backward-compat with the original inline stamp; `voice_memo` is
          // the canonical boolean flag (Phase 2.6 finish).
          origin: "voice_memo",
          voice_memo: true,
        } satisfies Record<string, Json>,
      },
    ];
  });

  return { posts, skipped };
}

export async function persistVoiceMemoPlan(
  args: PersistVoiceMemoPlanArgs,
): Promise<PersistResult> {
  const svc = supabaseService();
  const startAt = new Date();
  const endAt = new Date(startAt.getTime() + 7 * 24 * 60 * 60 * 1000);

  const { data: planRow, error: planErr } = await svc
    .from("posting_plans")
    .insert({
      workspace_id: args.workspaceId,
      name: args.result.plan.plan_name,
      start_at: startAt.toISOString(),
      end_at: endAt.toISOString(),
      status: "active",
      parent_plan_id: args.parentPlanId,
      generation_prompt: args.result.plan.overview,
      generation_response: args.result.plan as unknown as Json,
    })
    .select("id")
    .single();
  if (planErr || !planRow) {
    return { ok: false, error: planErr?.message ?? "Failed to save plan." };
  }

  const variants = flattenPlanVariants(args.result.plan);
  const { posts, skipped } = buildVoiceMemoPosts({
    variants,
    accounts: args.accounts,
    planId: planRow.id,
    workspaceId: args.workspaceId,
    sourceId: args.sourceId,
    hasVoiceProfile: args.brief.voice_profile != null,
    cacheReadInputTokens: args.result.usage.cache_read_input_tokens ?? 0,
  });

  if (posts.length === 0) {
    await svc.from("posting_plans").delete().eq("id", planRow.id);
    return {
      ok: false,
      error: "Claude generated only posts for channels you haven't connected.",
    };
  }

  const gatedPosts = await gateBatchForDedup(args.workspaceId, posts);

  const { error: postsErr } = await svc.from("posts").insert(gatedPosts);
  if (postsErr) {
    await svc.from("posting_plans").delete().eq("id", planRow.id);
    return { ok: false, error: postsErr.message };
  }

  try {
    await incrementPostsGenerated(args.workspaceId, posts.length);
  } catch (err) {
    console.warn("Failed to increment posts usage counter:", err);
  }

  return { ok: true, planId: planRow.id, skipped };
}
