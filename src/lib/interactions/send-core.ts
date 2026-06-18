// Phase 4.5 / Bet 4 — shared reply SEND core.
//
// =======================================================================
// This is the single place the X / Bluesky / LinkedIn reply helpers are
// invoked from. Both entry points call it:
//
//   * sendReplyAction (manual, server action, behind an authed click)
//   * runAutoReplies  (autonomous, cron, behind the trust gate + rate cap)
//
// Extracting it means the per-channel send code + the synthetic "audit
// posts row" bookkeeping is written ONCE. The two callers differ only in
// their own audit attribution (manual → approvals row with user_id;
// auto → auto_reply_log row) which they attach themselves.
//
// IG / Threads are deliberately NOT handled here. Their reply helpers throw
// MetaAppReviewPendingError; the manual action catches that to show a
// "coming soon" banner, and the auto path never reaches an IG/Threads row
// because the policy gate rejects those channels (channel_unsupported).
// Passing one in throws — fail loud rather than silently route to a stub.
// =======================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";
import { xReply, loadFreshXCredentials, type XCredentials } from "@/lib/social/x";
import { linkedinReply, type LinkedInCredentials } from "@/lib/social/linkedin";
import { blueskyReply, type BlueskyCredentials } from "@/lib/social/bluesky";
import { hashContent } from "@/lib/dedup/similarity";

type ServiceClient = SupabaseClient<Database>;
type SocialAccountRow = Database["public"]["Tables"]["social_accounts"]["Row"];
type InteractionRow = Database["public"]["Tables"]["interactions"]["Row"];

// The subset of an interaction the send core needs. Both callers already
// hold a full interactions row; this keeps the signature honest about what
// it actually reads.
export interface ReplyTarget {
  id: string;
  workspace_id: string;
  channel: InteractionRow["channel"];
  external_id: string;
  parent_post_id: string | null;
}

export interface SendReplyOutcome {
  externalId: string;
  // The synthetic posts row id created for audit parity, if it was created.
  // Null only if the platform send succeeded but the bookkeeping insert
  // failed (we never fail the whole send on a bookkeeping miss).
  postId: string | null;
}

// Performs the platform reply + creates the synthetic posts row used for
// cross-feature auditing (mirrors the outbound post pipeline). Throws on a
// failed platform send so the caller can record outcome='failed'.
//
// Does NOT insert an approvals row — that's the manual caller's job (it has
// a user_id; an auto-send has no actor and would violate the
// approvals_actor_exactly_one CHECK). Auto-sends are audited via
// auto_reply_log instead.
export async function sendReplyViaChannel(
  svc: ServiceClient,
  account: SocialAccountRow,
  interaction: ReplyTarget,
  replyText: string,
): Promise<SendReplyOutcome> {
  const externalId = await dispatchChannelReply(svc, account, interaction, replyText);

  const now = new Date().toISOString();
  let postId: string | null = null;
  const { data: postRow, error: postErr } = await svc
    .from("posts")
    .insert({
      workspace_id: interaction.workspace_id,
      social_account_id: account.id,
      channel: account.channel,
      text: replyText,
      // Migration 067: every posts insert stamps a content_hash so this row
      // participates in the dedup corpus via the indexed exact-match fast path
      // (status 'posted' is an ACTIVE_STATUS, so reply rows are corpus members).
      content_hash: hashContent(replyText),
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
    // The reply DID send. A bookkeeping miss must not surface as a failed
    // send — log and continue with a null postId.
    console.warn(
      "[send-core] reply sent but audit posts row insert failed:",
      postErr?.message,
    );
  } else {
    postId = postRow.id;
    await svc
      .from("posts")
      .update({ external_id: externalId, posted_at: now })
      .eq("id", postRow.id);
  }

  return { externalId, postId };
}

// Per-channel dispatch. Returns the platform-native id of the created reply.
// Throws on any failure (or on an unsupported channel).
async function dispatchChannelReply(
  svc: ServiceClient,
  account: SocialAccountRow,
  interaction: ReplyTarget,
  replyText: string,
): Promise<string> {
  switch (interaction.channel) {
    case "x": {
      const rawCreds = account.credentials as unknown as XCredentials;
      // X OAuth 2.0 tokens expire in ~2h; refresh-if-needed before posting.
      const creds = await loadFreshXCredentials(svc, account.id, rawCreds);
      const r = await xReply(creds, replyText, interaction.external_id);
      return r.id;
    }
    case "bluesky": {
      const creds = account.credentials as unknown as BlueskyCredentials;
      // external_id is the inbound's AT-URI = the parent post URI for a
      // reply. CID isn't persisted on our row; synthesise from the URI
      // tail. Bluesky rejects a mismatched CID hard, so a bad guess fails
      // loud rather than posting to the wrong thread. (Same fallback the
      // manual path uses; lifting it here keeps them identical.)
      const cidFallback = interaction.external_id.split("/").pop() ?? "unknown";
      const r = await blueskyReply(creds, replyText, {
        uri: interaction.external_id,
        cid: cidFallback,
      });
      return r.uri;
    }
    case "linkedin": {
      const creds = account.credentials as unknown as LinkedInCredentials;
      // LinkedIn replies need the parent ugcPost URN. Prefer the parent
      // post we own (its external_id); there's no usable fallback, so a
      // missing URN throws.
      let parentUrn: string | null = null;
      if (interaction.parent_post_id) {
        const { data: parentPost } = await svc
          .from("posts")
          .select("external_id")
          .eq("id", interaction.parent_post_id)
          .maybeSingle();
        parentUrn = parentPost?.external_id ?? null;
      }
      if (!parentUrn) {
        throw new Error("Can't reply on LinkedIn: parent post URN unknown.");
      }
      const r = await linkedinReply(creds, replyText, parentUrn);
      return r.id;
    }
    default:
      // x / bluesky / linkedin are the only auto-reply channels. IG/Threads
      // (or any other channel) must never reach the send core.
      throw new Error(`Channel not supported by send core: ${interaction.channel}`);
  }
}
