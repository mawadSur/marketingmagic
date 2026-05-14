"use server";

// Phase 6.8 — server actions for the /queue thread UI.
//
// All actions are workspace-scoped via getActiveWorkspaceOrRedirect; the
// loadThreadForWorkspace() helper additionally verifies every row of the
// thread belongs to the active workspace before mutating anything.

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { getActiveWorkspaceOrRedirect, getAuthedUserOrRedirect } from "@/lib/workspace";
import { regenerateHook } from "@/lib/threads/generate";
import { readThreadMeta, X_TWEET_MAX, HOOK_MAX } from "@/lib/threads/schema";
import type { VoiceProfile, Database } from "@/lib/db/types";
import type { ThreadStructure } from "@/lib/threads/schema";

type ActionResult = { error: string | null };
type HookRegenResult = { error: string | null; newText: string | null };

const uuid = z.string().uuid();
const ideaIdSchema = z.string().trim().min(1).max(120);

interface LoadedThread {
  rows: Array<Database["public"]["Tables"]["posts"]["Row"]>;
  workspaceId: string;
}

// Load every row of a thread (idea_id-keyed) AFTER verifying the active
// workspace owns at least one row. RLS would already do this, but the
// explicit filter is self-documenting + cheap.
async function loadThreadForWorkspace(ideaId: string): Promise<{
  error: string | null;
  thread: LoadedThread | null;
}> {
  if (!ideaIdSchema.safeParse(ideaId).success) {
    return { error: "Bad idea id.", thread: null };
  }
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("posts")
    .select("*")
    .eq("workspace_id", ws.id)
    .eq("idea_id", ideaId);
  if (error) return { error: error.message, thread: null };
  if (!data || data.length === 0) {
    return { error: "Thread not found in this workspace.", thread: null };
  }
  // Filter to thread rows only — defensive: idea_id is shared with cross-
  // channel ideas in Phase 2, so an idea_id can in principle have non-
  // thread rows too. We only act on rows that carry thread meta.
  const rows = data.filter((r) => readThreadMeta(r.generation_metadata) !== null);
  if (rows.length === 0) {
    return { error: "Idea has no thread rows.", thread: null };
  }
  return { error: null, thread: { rows, workspaceId: ws.id } };
}

// ─────────────────────────────────────────────────────────────
// Edit one tweet in a thread (in place).
// ─────────────────────────────────────────────────────────────
//
// Tweets cap at X_TWEET_MAX; hook (tweet_index=1) caps at HOOK_MAX so
// the punchy-opener rule stays enforced.
const tweetTextSchema = z.string().trim().min(1).max(X_TWEET_MAX);

export async function editThreadTweetAction(
  postId: string,
  newText: string,
): Promise<ActionResult> {
  if (!uuid.safeParse(postId).success) return { error: "Bad post id." };
  const parsed = tweetTextSchema.safeParse(newText);
  if (!parsed.success) return { error: `Tweet must be 1–${X_TWEET_MAX} chars.` };

  const ws = await getActiveWorkspaceOrRedirect();
  const user = await getAuthedUserOrRedirect();
  const supabase = await supabaseServer();

  const { data: post, error: loadErr } = await supabase
    .from("posts")
    .select("*")
    .eq("id", postId)
    .eq("workspace_id", ws.id)
    .maybeSingle();
  if (loadErr || !post) return { error: loadErr?.message ?? "Post not found." };
  const meta = readThreadMeta(post.generation_metadata);
  if (!meta) return { error: "Not a thread tweet." };
  if (post.status !== "pending_approval" && post.status !== "scheduled") {
    return { error: `Cannot edit from ${post.status}.` };
  }
  // Hook gets the punchier cap. Mirrors threadStructureSchema's superRefine.
  if (meta.role === "hook" && parsed.data.length > HOOK_MAX) {
    return { error: `Hook must be ≤${HOOK_MAX} chars.` };
  }
  if (post.text === parsed.data) return { error: null };

  const { error: updateErr } = await supabase
    .from("posts")
    .update({ text: parsed.data })
    .eq("id", postId);
  if (updateErr) return { error: updateErr.message };

  await supabase.from("approvals").insert({
    post_id: postId,
    user_id: user.id,
    action: "edited",
    diff: shortDiff(post.text, parsed.data),
  });
  revalidatePath("/queue");
  return { error: null };
}

// ─────────────────────────────────────────────────────────────
// Approve every pending tweet in a thread (single approval gate).
// ─────────────────────────────────────────────────────────────
export async function approveThreadAction(
  ideaId: string,
): Promise<ActionResult & { approved: number }> {
  const { error, thread } = await loadThreadForWorkspace(ideaId);
  if (error || !thread) return { error, approved: 0 };
  const user = await getAuthedUserOrRedirect();
  const supabase = await supabaseServer();

  const pendingIds = thread.rows
    .filter((r) => r.status === "pending_approval")
    .map((r) => r.id);
  if (pendingIds.length === 0) return { error: null, approved: 0 };

  const now = new Date().toISOString();
  const { error: updateErr } = await supabase
    .from("posts")
    .update({ status: "scheduled", approved_at: now })
    .in("id", pendingIds);
  if (updateErr) return { error: updateErr.message, approved: 0 };

  const approvals = pendingIds.map((postId) => ({
    post_id: postId,
    user_id: user.id,
    action: "approved" as const,
    diff: null,
  }));
  await supabase.from("approvals").insert(approvals);

  revalidatePath("/queue");
  return { error: null, approved: pendingIds.length };
}

// ─────────────────────────────────────────────────────────────
// Regenerate hook only (Claude call, then write back to tweet_index=1).
// ─────────────────────────────────────────────────────────────
export async function regenerateHookAction(ideaId: string): Promise<HookRegenResult> {
  const { error, thread } = await loadThreadForWorkspace(ideaId);
  if (error || !thread) return { error, newText: null };

  // Sort rows by tweet_index — we need the existing sequence so Claude
  // knows what tweet 2 expects the new hook to lead into.
  const sorted = [...thread.rows].sort((a, b) => {
    const ma = readThreadMeta(a.generation_metadata)!;
    const mb = readThreadMeta(b.generation_metadata)!;
    return ma.tweet_index - mb.tweet_index;
  });
  const hookRow = sorted[0];
  const hookMeta = readThreadMeta(hookRow.generation_metadata)!;
  if (hookMeta.role !== "hook") {
    return { error: "Thread is malformed (no hook tweet).", newText: null };
  }
  if (hookRow.status !== "pending_approval") {
    return {
      error: "Hook can only be regenerated while the thread is pending approval.",
      newText: null,
    };
  }

  // Load voice profile + brief context for voice-aware regeneration.
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();
  const { data: brief } = await supabase
    .from("brand_briefs")
    .select("voice_profile, product_description, target_audience, voice")
    .eq("workspace_id", ws.id)
    .maybeSingle();

  const currentThread: ThreadStructure = sorted.map((r) => {
    const m = readThreadMeta(r.generation_metadata)!;
    return { tweet_number: m.tweet_index, text: r.text, role: m.role };
  });

  let result: { text: string };
  try {
    result = await regenerateHook({
      currentThread,
      voiceProfile: (brief?.voice_profile ?? null) as VoiceProfile | null,
      briefContext: brief
        ? {
            productDescription: brief.product_description,
            targetAudience: brief.target_audience,
            voice: brief.voice,
          }
        : undefined,
    });
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Hook regeneration failed.",
      newText: null,
    };
  }

  // Write the new hook in place. Audit row as an "edited" approval so
  // /history surfaces it consistently with manual edits.
  const user = await getAuthedUserOrRedirect();
  const { error: updateErr } = await supabase
    .from("posts")
    .update({ text: result.text })
    .eq("id", hookRow.id);
  if (updateErr) return { error: updateErr.message, newText: null };

  await supabase.from("approvals").insert({
    post_id: hookRow.id,
    user_id: user.id,
    action: "edited",
    diff: `regenerated hook\n${shortDiff(hookRow.text, result.text)}`,
  });

  revalidatePath("/queue");
  return { error: null, newText: result.text };
}

// ─────────────────────────────────────────────────────────────
// Retry a partially-published thread.
// ─────────────────────────────────────────────────────────────
//
// Re-arms the failed-rows so the next cron tick (or an immediate
// re-trigger) picks them up. The cron's postThread() reconciles against
// the ledger first, so re-running is safe even if a previous run posted
// some rows but didn't update the DB.
export async function retryPartialThreadAction(
  ideaId: string,
): Promise<ActionResult & { rearmed: number }> {
  const { error, thread } = await loadThreadForWorkspace(ideaId);
  if (error || !thread) return { error, rearmed: 0 };

  const supabase = await supabaseServer();
  const failedIds = thread.rows
    .filter((r) => r.status === "failed" && !r.external_id)
    .map((r) => r.id);
  if (failedIds.length === 0) {
    return { error: "No failed tweets to retry.", rearmed: 0 };
  }

  // Flip status back to 'scheduled' with the original scheduled_at — the
  // cron picks up rows whose scheduled_at <= now(), so as long as
  // scheduled_at is in the past it will run on the very next tick.
  // We DON'T clear external_id here (it's already NULL for failed
  // tweets) and we DO clear failure_reason so the queue UI reflects the
  // retry attempt.
  const svc = supabaseService();
  const { error: updateErr } = await svc
    .from("posts")
    .update({ status: "scheduled", failure_reason: null })
    .in("id", failedIds);
  if (updateErr) return { error: updateErr.message, rearmed: 0 };

  revalidatePath("/queue");
  return { error: null, rearmed: failedIds.length };
}

function shortDiff(before: string, after: string): string {
  return `- ${before}\n+ ${after}`.slice(0, 4000);
}
