"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { getActiveWorkspaceOrRedirect, getAuthedUserOrRedirect } from "@/lib/workspace";
import { defaultImageProvider } from "@/lib/images";
import { maxCharsFor } from "@/lib/channels/registry";

type ActionResult = { error: string | null };
type GenerateImageResult = { error: string | null; publicUrl: string | null };

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

export async function editPostAction(postId: string, text: string): Promise<ActionResult> {
  if (!uuid.safeParse(postId).success) return { error: "Bad post id." };

  const { error, post, user, supabase } = await loadPostForWorkspace(postId);
  if (error || !post) return { error };

  const max = maxCharsFor(post.channel);
  const editSchema = z.string().trim().min(1).max(max);
  const parsed = editSchema.safeParse(text);
  if (!parsed.success) return { error: `Text must be 1-${max} characters for ${post.channel}.` };
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

const promptSchema = z.string().trim().min(3).max(500);

export async function generatePostImageAction(
  postId: string,
  prompt: string,
): Promise<GenerateImageResult> {
  if (!uuid.safeParse(postId).success) return { error: "Bad post id.", publicUrl: null };
  const parsed = promptSchema.safeParse(prompt);
  if (!parsed.success) {
    return { error: "Prompt must be 3-500 characters.", publicUrl: null };
  }

  const { error, post } = await loadPostForWorkspace(postId);
  if (error || !post) return { error, publicUrl: null };
  if (post.status !== "pending_approval") {
    return { error: `Cannot generate image from ${post.status}.`, publicUrl: null };
  }

  // Generate via the configured provider.
  let img;
  try {
    img = await defaultImageProvider().generate({
      prompt: parsed.data,
      aspect: "landscape",
    });
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Image generation failed.",
      publicUrl: null,
    };
  }

  // Upload to Supabase Storage (service-role: RLS-bypass since we just
  // verified workspace membership above via loadPostForWorkspace).
  const ext = img.contentType === "image/png" ? "png" : img.contentType === "image/webp" ? "webp" : "jpg";
  const filename = `${Date.now()}.${ext}`;
  const storagePath = `${post.workspace_id}/${postId}/${filename}`;
  const svc = supabaseService();
  const { error: upErr } = await svc.storage
    .from("post-media")
    .upload(storagePath, img.bytes, {
      contentType: img.contentType,
      upsert: false,
    });
  if (upErr) return { error: `Storage upload failed: ${upErr.message}`, publicUrl: null };

  // Replace any prior image on this post — single image per post for V1.
  // (We could keep a history later by appending instead.)
  const oldMedia = Array.isArray(post.media) ? (post.media as unknown as { storage_path?: string }[]) : [];
  for (const old of oldMedia) {
    if (old?.storage_path) {
      await svc.storage.from("post-media").remove([old.storage_path]);
    }
  }

  const mediaEntry = {
    kind: "image" as const,
    storage_path: storagePath,
    content_type: img.contentType,
    prompt: parsed.data,
    width: img.width,
    height: img.height,
    meta: img.meta,
  };

  const { error: updateErr } = await svc
    .from("posts")
    .update({ media: [mediaEntry] as never })
    .eq("id", postId);
  if (updateErr) {
    await svc.storage.from("post-media").remove([storagePath]);
    return { error: updateErr.message, publicUrl: null };
  }

  const { data: pub } = svc.storage.from("post-media").getPublicUrl(storagePath);
  revalidatePath("/queue");
  return { error: null, publicUrl: pub.publicUrl };
}

export async function clearPostImageAction(postId: string): Promise<ActionResult> {
  if (!uuid.safeParse(postId).success) return { error: "Bad post id." };
  const { error, post } = await loadPostForWorkspace(postId);
  if (error || !post) return { error };
  if (post.status !== "pending_approval") {
    return { error: `Cannot clear image from ${post.status}.` };
  }

  const svc = supabaseService();
  const oldMedia = Array.isArray(post.media) ? (post.media as unknown as { storage_path?: string }[]) : [];
  for (const old of oldMedia) {
    if (old?.storage_path) {
      await svc.storage.from("post-media").remove([old.storage_path]);
    }
  }
  const { error: updateErr } = await svc
    .from("posts")
    .update({ media: [] as never })
    .eq("id", postId);
  if (updateErr) return { error: updateErr.message };

  revalidatePath("/queue");
  return { error: null };
}
