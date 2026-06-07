"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import {
  getActiveWorkspaceOrRedirect,
  getAuthedUserOrRedirect,
} from "@/lib/workspace";
import {
  draftReply,
  type ReplyInteractionInput,
  type ReplyWorkspaceContext,
} from "@/lib/interactions/draft-reply";
import { instagramReply } from "@/lib/social/instagram";
import { threadsReply } from "@/lib/social/threads";
import { MetaAppReviewPendingError } from "@/lib/interactions/errors";
import { sendReplyViaChannel } from "@/lib/interactions/send-core";
import { isAutoReplyChannel } from "@/lib/interactions/auto-reply/policy";
import { interactionToSource } from "@/lib/sources/from-interaction";

const uuid = z.string().uuid();
const replyTextSchema = z.string().trim().min(1).max(3000);

export interface DraftActionResult {
  drafts: string[];
  error: string | null;
}

// =======================================================================
// MANUAL reply send — the human-in-the-loop path.
//
// This is the DEFAULT path: a human reviews a draft and clicks "Send".
// It requires:
//   - an authed user session (getAuthedUserOrRedirect throws otherwise)
//   - a server action invocation (Next.js gates these via formData / use
//     server boundary; can't be triggered from a cron or webhook)
//   - explicit reply text in the payload (no "send the first draft" path)
//
// As of Bet 4 there is a SECOND, separate send entry point — the
// autonomous auto-reply path in src/lib/interactions/auto-reply/* invoked
// by the poll-interactions cron. That path is OFF by default and only
// fires on channels the workspace has explicitly trusted AND opted into,
// under a workspace kill switch and a per-platform rate cap. Both paths
// share the per-channel send code in src/lib/interactions/send-core.ts so
// there is exactly one place we hit a platform reply endpoint.
//
// This MANUAL action still never consults trust_mode: a human clicking
// "Send" always sends regardless of trust state. The trust gate only
// governs the autonomous path.
// =======================================================================
export interface SendReplyResult {
  error: string | null;
  externalId: string | null;
}

export async function sendReplyAction(
  interactionId: string,
  replyText: string,
): Promise<SendReplyResult> {
  if (!uuid.safeParse(interactionId).success) {
    return { error: "Bad interaction id.", externalId: null };
  }
  const replyParsed = replyTextSchema.safeParse(replyText);
  if (!replyParsed.success) {
    return { error: "Reply text required (≤3000 chars).", externalId: null };
  }

  const ws = await getActiveWorkspaceOrRedirect();
  const user = await getAuthedUserOrRedirect();
  const supabase = await supabaseServer();
  const svc = supabaseService();

  // Load the interaction.
  const { data: interaction, error: loadErr } = await supabase
    .from("interactions")
    .select("*")
    .eq("id", interactionId)
    .eq("workspace_id", ws.id)
    .maybeSingle();
  if (loadErr || !interaction) {
    return {
      error: loadErr?.message ?? "Interaction not found.",
      externalId: null,
    };
  }
  if (interaction.status === "replied") {
    return { error: "You already replied to this.", externalId: null };
  }

  // Load the social account (and its credentials) using the service
  // client. Credentials live behind a privileged view in our schema —
  // we use the same pattern as dispatchPost / pull-metrics.
  const { data: account, error: acctErr } = await svc
    .from("social_accounts")
    .select("*")
    .eq("id", interaction.social_account_id)
    .maybeSingle();
  if (acctErr || !account) {
    return {
      error: acctErr?.message ?? "Connected account not found.",
      externalId: null,
    };
  }

  // Send. X / Bluesky / LinkedIn go through the shared send core (which
  // also creates the synthetic audit posts row). IG / Threads remain
  // stubbed inline: their helpers throw MetaAppReviewPendingError, which
  // we catch and surface as a "coming soon" banner. Keeping them out of
  // the send core is deliberate — the core only knows the shippable set.
  let externalId: string;
  let postId: string | null;
  try {
    if (isAutoReplyChannel(interaction.channel)) {
      const result = await sendReplyViaChannel(svc, account, interaction, replyParsed.data);
      externalId = result.externalId;
      postId = result.postId;
    } else if (interaction.channel === "instagram") {
      await instagramReply(account.credentials as never, replyParsed.data, interaction.external_id);
      return { error: "Unreachable", externalId: null };
    } else if (interaction.channel === "threads") {
      await threadsReply(account.credentials as never, replyParsed.data, interaction.external_id);
      return { error: "Unreachable", externalId: null };
    } else {
      return { error: `Unsupported channel: ${interaction.channel}`, externalId: null };
    }
  } catch (err) {
    if (err instanceof MetaAppReviewPendingError) {
      return {
        error:
          "Replies for Instagram / Threads are pending Meta App Review. Coming soon.",
        externalId: null,
      };
    }
    return {
      error: err instanceof Error ? err.message : "Reply send failed.",
      externalId: null,
    };
  }

  // Manual-path audit attribution: record the human approval against the
  // synthetic posts row the send core created. (The autonomous path
  // attributes to auto_reply_log instead — an auto-send has no user_id and
  // would violate the approvals_actor_exactly_one CHECK.)
  const now = new Date().toISOString();
  if (postId) {
    await svc.from("approvals").insert({
      post_id: postId,
      user_id: user.id,
      action: "approved",
      diff: null,
    });
  }

  // Flip the interaction to replied.
  await supabase
    .from("interactions")
    .update({
      status: "replied",
      replied_at: now,
      replied_to_post_id: postId,
    })
    .eq("id", interaction.id);

  revalidatePath("/inbox");
  revalidatePath(`/inbox/${interaction.id}`);
  return { error: null, externalId };
}

// Server action wrapping the Claude drafter. Returns 1-2 candidate
// strings. The detail page calls this on demand (button click) so we
// don't burn tokens on every page load.
export async function draftReplyAction(
  interactionId: string,
): Promise<DraftActionResult> {
  if (!uuid.safeParse(interactionId).success) {
    return { drafts: [], error: "Bad interaction id." };
  }
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();

  const { data: interaction, error: loadErr } = await supabase
    .from("interactions")
    .select("*")
    .eq("id", interactionId)
    .eq("workspace_id", ws.id)
    .maybeSingle();
  if (loadErr || !interaction) {
    return { drafts: [], error: loadErr?.message ?? "Interaction not found." };
  }

  const { data: brief } = await supabase
    .from("brand_briefs")
    .select("voice, voice_profile, do_not_say, product_description")
    .eq("workspace_id", ws.id)
    .maybeSingle();

  let parentPostText: string | null = null;
  if (interaction.parent_post_id) {
    const { data: parent } = await supabase
      .from("posts")
      .select("text")
      .eq("id", interaction.parent_post_id)
      .maybeSingle();
    parentPostText = parent?.text ?? null;
  }

  const input: ReplyInteractionInput = {
    channel: interaction.channel,
    author_handle: interaction.author_handle,
    author_display_name: interaction.author_display_name,
    body: interaction.body,
  };
  const ctx: ReplyWorkspaceContext = {
    voiceProfile: brief?.voice_profile ?? null,
    voice: brief?.voice ?? "",
    doNotSay: brief?.do_not_say ?? [],
    productDescription: brief?.product_description ?? "",
    parentPostText,
  };

  try {
    const result = await draftReply(input, ctx);
    return { drafts: result.drafts, error: null };
  } catch (err) {
    return {
      drafts: [],
      error: err instanceof Error ? err.message : "Draft failed.",
    };
  }
}

// "Use as source →" — convert this interaction into a Phase 2.5
// sources row of kind='transcript'. Wraps the lib helper so the page
// can call it from a form action.
export async function useAsSourceAction(
  interactionId: string,
): Promise<{ sourceId: string | null; error: string | null }> {
  if (!uuid.safeParse(interactionId).success) {
    return { sourceId: null, error: "Bad interaction id." };
  }
  return interactionToSource(interactionId);
}
