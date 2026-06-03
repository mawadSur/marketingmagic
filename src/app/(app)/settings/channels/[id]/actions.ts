"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { getActiveWorkspaceOrRedirect, getAuthedUserOrRedirect } from "@/lib/workspace";

type ActionResult = { error: string | null };
const uuid = z.string().uuid();

export async function setTrustModeAction(
  accountId: string,
  enable: boolean,
): Promise<ActionResult> {
  if (!uuid.safeParse(accountId).success) return { error: "Bad account id." };
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();

  // Eligibility check on enable.
  if (enable) {
    const { data: acct } = await supabase
      .from("social_accounts_safe")
      .select("successful_post_count, trust_threshold")
      .eq("id", accountId)
      .eq("workspace_id", ws.id)
      .maybeSingle();
    if (!acct) return { error: "Account not found." };
    if (acct.successful_post_count < acct.trust_threshold) {
      return { error: "Not yet eligible — need more successful posts." };
    }
  }

  const { error } = await supabase
    .from("social_accounts")
    .update({ trust_mode: enable })
    .eq("id", accountId)
    .eq("workspace_id", ws.id);
  if (error) return { error: error.message };

  revalidatePath(`/settings/channels/${accountId}`);
  revalidatePath("/dashboard");
  return { error: null };
}

// Disconnect a connected channel. Soft state, not a hard delete: posts
// reference social_accounts with `on delete restrict`, so removing a row a
// workspace has posted through is impossible (and would orphan history). We
// flip status to 'disconnected' and wipe the stored credentials so we hold no
// live tokens for an account the user has cut off. The dispatcher/cron only
// act on status='connected', and the channels listing + quota exclude
// 'disconnected', so the slot frees up. Reconnecting (the OAuth/app-password
// upsert) flips status back to 'connected' and restores credentials.
export async function disconnectAccountAction(accountId: string): Promise<ActionResult> {
  if (!uuid.safeParse(accountId).success) return { error: "Bad account id." };
  const ws = await getActiveWorkspaceOrRedirect();
  const svc = supabaseService();

  // Scope the write to the active workspace so a user can't disconnect another
  // workspace's account by guessing an id. Confirm the row exists + belongs
  // here before mutating.
  const { data: acct } = await svc
    .from("social_accounts")
    .select("id")
    .eq("id", accountId)
    .eq("workspace_id", ws.id)
    .maybeSingle();
  if (!acct) return { error: "Account not found." };

  const { error } = await svc
    .from("social_accounts")
    .update({ status: "disconnected", trust_mode: false, credentials: {} })
    .eq("id", accountId)
    .eq("workspace_id", ws.id);
  if (error) return { error: error.message };

  revalidatePath("/settings/channels");
  revalidatePath(`/settings/channels/${accountId}`);
  revalidatePath("/dashboard");
  return { error: null };
}

// Resets the trust counter for the channel and forces trust_mode back to false.
// Called when the user flags a posted post as "should not have posted" — one strike,
// you lose autopilot until you re-earn it.
export async function flagPostAsRegrettableAction(postId: string): Promise<ActionResult> {
  if (!uuid.safeParse(postId).success) return { error: "Bad post id." };
  const ws = await getActiveWorkspaceOrRedirect();
  const user = await getAuthedUserOrRedirect();
  const svc = supabaseService();

  const { data: post } = await svc
    .from("posts")
    .select("id, social_account_id, workspace_id, status")
    .eq("id", postId)
    .eq("workspace_id", ws.id)
    .maybeSingle();
  if (!post) return { error: "Post not found." };
  if (post.status !== "posted") return { error: "Only posted items can be flagged." };

  const { error: acctErr } = await svc
    .from("social_accounts")
    .update({ trust_mode: false, successful_post_count: 0 })
    .eq("id", post.social_account_id);
  if (acctErr) return { error: acctErr.message };

  await svc.from("approvals").insert({
    post_id: postId,
    user_id: user.id,
    action: "unapproved",
    diff: "flagged: should not have posted",
  });

  revalidatePath(`/settings/channels/${post.social_account_id}`);
  revalidatePath("/dashboard");
  return { error: null };
}
