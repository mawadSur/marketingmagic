"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { channelSpec, ENABLED_CHANNELS, type ChannelId } from "@/lib/channels/registry";
import { nextRecommendedSlot } from "@/lib/channels/best-times";
import { hashContent } from "@/lib/dedup/similarity";

// ─────────────────────────────────────────────────────────────
// createDraftPostAction — single-post compose
// ─────────────────────────────────────────────────────────────
//
// The /new flows (plans/goals/sources/workspaces) all require a brand brief,
// a connected channel, AND a bulk-generated plan before anything lands in the
// queue. A user who just wants to write ONE post and ship it had no path.
//
// This action inserts ONE draft (status='pending_approval') for a channel the
// workspace has connected — NO brand-brief requirement. It then re-enters the
// existing approval pipeline: the draft shows up in the queue where the user
// can Approve (→ scheduled, picked up by the cron) or "Publish now".
//
// Validation mirrors the other post-creating paths: the channel must be one
// of the connected social accounts (social_accounts_safe, status='connected'),
// and the body must fit channelSpec().maxChars for that channel.

export type CreateDraftResult = { error: string | null; postId: string | null };

const channelSchema = z.enum(ENABLED_CHANNELS as [ChannelId, ...ChannelId[]]);

export async function createDraftPostAction(input: {
  channel: string;
  text: string;
}): Promise<CreateDraftResult> {
  const channelParsed = channelSchema.safeParse(input.channel);
  if (!channelParsed.success) return { error: "Pick a connected channel.", postId: null };
  const channel = channelParsed.data;

  const spec = channelSpec(channel);
  if (!spec) return { error: "Unknown channel.", postId: null };

  const textSchema = z.string().trim().min(1).max(spec.maxChars);
  const textParsed = textSchema.safeParse(input.text);
  if (!textParsed.success) {
    return {
      error: `Text must be 1-${spec.maxChars} characters for ${spec.label}.`,
      postId: null,
    };
  }

  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();

  // The channel must be connected in this workspace — resolve the account id
  // the post will publish through. Same guard the goal/plan paths use.
  const { data: account, error: acctErr } = await supabase
    .from("social_accounts_safe")
    .select("id")
    .eq("workspace_id", ws.id)
    .eq("channel", channel)
    .eq("status", "connected")
    .maybeSingle();
  if (acctErr) return { error: acctErr.message, postId: null };
  if (!account) {
    return { error: `Connect ${spec.label} before composing a post.`, postId: null };
  }

  // Give the draft a sensible default time (next recommended window for the
  // channel) so it never lands in the queue as "no time set". Still
  // pending_approval — the user reviews + can retime before it ships.
  const suggestedSlot =
    nextRecommendedSlot(channel) ?? new Date().toISOString();

  const { data: inserted, error: insertErr } = await supabase
    .from("posts")
    .insert({
      workspace_id: ws.id,
      social_account_id: account.id,
      channel,
      text: textParsed.data,
      // Stamp the content hash so the dedup gate's exact-match path can catch a
      // future re-queue of this exact post (and never auto-publish a dup).
      content_hash: hashContent(textParsed.data),
      status: "pending_approval",
      scheduled_at: suggestedSlot,
      generation_metadata: { source: "compose" },
    })
    .select("id")
    .single();
  if (insertErr || !inserted) {
    return { error: insertErr?.message ?? "Could not create the post.", postId: null };
  }

  revalidatePath("/queue");
  return { error: null, postId: inserted.id };
}
