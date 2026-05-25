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
import { xReply, loadFreshXCredentials, type XCredentials } from "@/lib/social/x";
import {
  linkedinReply,
  type LinkedInCredentials,
} from "@/lib/social/linkedin";
import {
  blueskyReply,
  type BlueskyCredentials,
} from "@/lib/social/bluesky";
import { instagramReply } from "@/lib/social/instagram";
import { threadsReply } from "@/lib/social/threads";
import { MetaAppReviewPendingError } from "@/lib/interactions/errors";
import { interactionToSource } from "@/lib/sources/from-interaction";

const uuid = z.string().uuid();
const replyTextSchema = z.string().trim().min(1).max(3000);

export interface DraftActionResult {
  drafts: string[];
  error: string | null;
}

// =======================================================================
// HARD RULE — sendReplyAction is the ONLY entry point that calls a
// platform reply helper. It requires:
//   - an authed user session (getAuthedUserOrRedirect throws otherwise)
//   - a server action invocation (Next.js gates these via formData / use
//     server boundary; can't be triggered from a cron or webhook)
//   - explicit reply text in the payload (no "send the first draft" path)
//
// Even with trust_mode=true on the social_accounts row (which lets
// posts skip the approval step), this action does NOT consult
// trust_mode. Replies always require a manual click.
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

  // Send via the channel-appropriate helper. The IG / Threads helpers
  // throw MetaAppReviewPendingError; we catch and surface a friendly
  // error so the UI shows a "coming soon" banner instead of a generic
  // 500.
  let externalId: string;
  try {
    switch (interaction.channel) {
      case "x": {
        const rawCreds = account.credentials as unknown as XCredentials;
        // Refresh-if-needed before posting — X OAuth 2.0 tokens expire in ~2h.
        const creds = await loadFreshXCredentials(svc, account.id, rawCreds);
        const r = await xReply(creds, replyParsed.data, interaction.external_id);
        externalId = r.id;
        break;
      }
      case "linkedin": {
        const creds = account.credentials as unknown as LinkedInCredentials;
        // For LinkedIn we need the parent UGC post URN. The poller
        // stores the parent post's external_id (URN) as the in-reply
        // target, but we don't have a separate column — fall back to
        // either the parent_post_id's external_id (preferred) or the
        // interaction's own external_id (which is the comment URN's
        // parent in the URN structure).
        let parentUrn: string | null = null;
        if (interaction.parent_post_id) {
          const { data: parentPost } = await supabase
            .from("posts")
            .select("external_id")
            .eq("id", interaction.parent_post_id)
            .maybeSingle();
          parentUrn = parentPost?.external_id ?? null;
        }
        if (!parentUrn) {
          return {
            error: "Can't reply on LinkedIn: parent post URN unknown.",
            externalId: null,
          };
        }
        const r = await linkedinReply(creds, replyParsed.data, parentUrn);
        externalId = r.id;
        break;
      }
      case "bluesky": {
        const creds = account.credentials as unknown as BlueskyCredentials;
        // The Bluesky reply needs parent URI + CID. external_id is the
        // notification URI, which IS the parent post AT-URI for
        // replies; CID is included in the notification body but not
        // persisted on our row. For a clean V1 we pass URI as both
        // and CID-from-URI extraction is left for the day we add a
        // dedicated column. As a defensive fallback, we synthesise a
        // CID from the URI tail — Bluesky rejects mismatched CIDs
        // hard, so failure surfaces clearly.
        const cidFallback = interaction.external_id.split("/").pop() ?? "unknown";
        const r = await blueskyReply(
          creds,
          replyParsed.data,
          { uri: interaction.external_id, cid: cidFallback },
        );
        externalId = r.uri;
        break;
      }
      case "instagram": {
        await instagramReply(
          account.credentials as never,
          replyParsed.data,
          interaction.external_id,
        );
        return { error: "Unreachable", externalId: null };
      }
      case "threads": {
        await threadsReply(
          account.credentials as never,
          replyParsed.data,
          interaction.external_id,
        );
        return { error: "Unreachable", externalId: null };
      }
      default:
        return {
          error: `Unsupported channel: ${interaction.channel}`,
          externalId: null,
        };
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

  // Audit parity: create a posts row for the reply so the approvals
  // table can reference it (approvals.post_id is NOT NULL). This is
  // the same shape the social pipeline uses for outbound posts; the
  // queue UI filters by status='pending_approval' | 'scheduled' so a
  // 'posted' reply row won't pollute that view.
  const now = new Date().toISOString();
  const { data: postRow, error: postErr } = await svc
    .from("posts")
    .insert({
      workspace_id: ws.id,
      social_account_id: account.id,
      channel: account.channel,
      text: replyParsed.data,
      status: "posted",
      generation_metadata: {
        kind: "reply",
        interaction_id: interaction.id,
        replied_to_external_id: interaction.external_id,
      },
    })
    .select("id")
    .single();
  if (postErr || !postRow) {
    // Don't fail the whole action — the reply DID send. Log audit
    // gap and continue.
    console.warn(
      "[inbox] reply sent but audit post row insert failed:",
      postErr?.message,
    );
  } else {
    // Stamp the external_id + posted_at on the audit row via Update
    // (the Insert type omits external_id; Update accepts it).
    await svc
      .from("posts")
      .update({ external_id: externalId, posted_at: now })
      .eq("id", postRow.id);
    await svc.from("approvals").insert({
      post_id: postRow.id,
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
      replied_to_post_id: postRow?.id ?? null,
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
