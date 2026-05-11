"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { getActiveWorkspaceOrRedirect, getAuthedUserOrRedirect } from "@/lib/workspace";

type ActionResult = { error: string | null };

const uuid = z.string().uuid();

async function loadPostForWorkspace(postId: string) {
  const ws = await getActiveWorkspaceOrRedirect();
  const user = await getAuthedUserOrRedirect();
  const supabase = await supabaseServer();
  const { data: post, error } = await supabase
    .from("posts")
    .select("*")
    .eq("id", postId)
    .eq("workspace_id", ws.id)
    .maybeSingle();
  if (error || !post) return { error: error?.message ?? "Post not found.", post: null, user, supabase };
  return { error: null, post, user, supabase };
}

export async function approvePostAction(postId: string): Promise<ActionResult> {
  if (!uuid.safeParse(postId).success) return { error: "Bad post id." };
  const { error, post, user, supabase } = await loadPostForWorkspace(postId);
  if (error || !post) return { error };
  if (post.status !== "pending_approval") {
    return { error: `Cannot approve from ${post.status}.` };
  }

  const now = new Date().toISOString();
  const { error: updateErr } = await supabase
    .from("posts")
    .update({ status: "scheduled", approved_at: now })
    .eq("id", postId);
  if (updateErr) return { error: updateErr.message };

  await supabase.from("approvals").insert({
    post_id: postId,
    user_id: user.id,
    action: "approved",
    diff: null,
  });

  revalidatePath("/queue");
  return { error: null };
}

export async function rejectPostAction(postId: string): Promise<ActionResult> {
  if (!uuid.safeParse(postId).success) return { error: "Bad post id." };
  const { error, post, user, supabase } = await loadPostForWorkspace(postId);
  if (error || !post) return { error };
  if (post.status !== "pending_approval") {
    return { error: `Cannot reject from ${post.status}.` };
  }

  const { error: updateErr } = await supabase
    .from("posts")
    .update({ status: "rejected" })
    .eq("id", postId);
  if (updateErr) return { error: updateErr.message };

  await supabase.from("approvals").insert({
    post_id: postId,
    user_id: user.id,
    action: "rejected",
    diff: null,
  });

  revalidatePath("/queue");
  return { error: null };
}

const editSchema = z.string().trim().min(1).max(280);

export async function editPostAction(postId: string, text: string): Promise<ActionResult> {
  if (!uuid.safeParse(postId).success) return { error: "Bad post id." };
  const parsed = editSchema.safeParse(text);
  if (!parsed.success) return { error: "Text must be 1-280 characters." };

  const { error, post, user, supabase } = await loadPostForWorkspace(postId);
  if (error || !post) return { error };
  if (post.status !== "pending_approval") {
    return { error: `Cannot edit from ${post.status}.` };
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

export async function revokePostAction(postId: string): Promise<ActionResult> {
  if (!uuid.safeParse(postId).success) return { error: "Bad post id." };
  const { error, post, user, supabase } = await loadPostForWorkspace(postId);
  if (error || !post) return { error };
  if (post.status !== "scheduled") {
    return { error: `Cannot revoke from ${post.status}.` };
  }

  const { error: updateErr } = await supabase
    .from("posts")
    .update({ status: "pending_approval", approved_at: null, revoked_at: new Date().toISOString() })
    .eq("id", postId);
  if (updateErr) return { error: updateErr.message };

  await supabase.from("approvals").insert({
    post_id: postId,
    user_id: user.id,
    action: "unapproved",
    diff: null,
  });

  revalidatePath("/queue");
  return { error: null };
}

function shortDiff(before: string, after: string): string {
  const head = `- ${before}`;
  const tail = `+ ${after}`;
  return `${head}\n${tail}`.slice(0, 4000);
}
