"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { getActiveWorkspaceOrRedirect, getAuthedUserOrRedirect } from "@/lib/workspace";
import { generateGroupDrafts } from "@/lib/groups/generate";
import { postingVerdictNow, type GroupPostingRules } from "@/lib/groups/posting-rules";
import type { FacebookGroupPromoPolicy } from "@/lib/db/types";

// Server actions for Facebook Group Assist. Everything is workspace-scoped via
// the active workspace + RLS (members can read/write their own rows). These
// never touch the `posts` table or the publish pipeline — group drafts are a
// human-in-the-loop surface (Meta removed the Groups API on 2024-04-22).

type ActionResult = { error: string | null };
const uuid = z.string().uuid();

// ── Group CRUD ───────────────────────────────────────────────────────────

const weekdaysSchema = z
  .array(z.number().int().min(1).max(7))
  .max(7)
  .transform((days) => Array.from(new Set(days)).sort((a, b) => a - b));

// Validate a Facebook group URL by *parsing* it, not by substring-matching the
// raw string. A substring check (e.g. /facebook\.com\/groups\//) is unsafe here
// because the stored URL is later rendered as an <a href> / window.open target
// in group-card.tsx: hostile inputs like "https://evil.com/x?q=facebook.com/groups/abc",
// "https://notfacebook.com/groups/", or "https://facebook.com.evil.com/groups/"
// all contain the substring but point elsewhere, and "javascript:" pseudo-URLs
// can carry the substring too. The WHATWG parser gives us the real protocol,
// host, and path so we can require https + the genuine facebook.com host.
function isFacebookGroupUrl(u: string): boolean {
  try {
    const parsed = new URL(u);
    // Only real web links — rejects javascript:, data:, etc.
    if (parsed.protocol !== "https:") return false;
    // Exact host or a true subdomain (www./m./mbasic.facebook.com), never a
    // substring (so "notfacebook.com" and "facebook.com.evil.com" are rejected).
    const host = parsed.hostname.toLowerCase();
    const isFacebookHost = host === "facebook.com" || host.endsWith(".facebook.com");
    if (!isFacebookHost) return false;
    return parsed.pathname.startsWith("/groups/");
  } catch {
    // new URL throws on garbage / pseudo-URLs — treat as invalid.
    return false;
  }
}

const groupInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  // Require a real Facebook group link (vanity URLs + mobile hosts are fine).
  // Host/protocol are parsed (see isFacebookGroupUrl) rather than substring-matched.
  url: z
    .string()
    .trim()
    .url()
    .refine(
      isFacebookGroupUrl,
      "Enter a Facebook group URL (facebook.com/groups/…).",
    ),
  member_count: z
    .union([z.number().int().min(0).max(100_000_000), z.null()])
    .optional()
    .transform((v) => v ?? null),
  promo_policy: z.enum(["open", "limited", "value_only"]),
  promo_weekdays: weekdaysSchema,
  allow_links: z.boolean(),
  rules_notes: z.string().trim().max(2000).default(""),
});

export type GroupInput = z.input<typeof groupInputSchema>;

export async function createGroupAction(input: GroupInput): Promise<ActionResult & { groupId: string | null }> {
  const parsed = groupInputSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid group.", groupId: null };
  }
  const ws = await getActiveWorkspaceOrRedirect();
  const user = await getAuthedUserOrRedirect();
  const supabase = await supabaseServer();

  const { data, error } = await supabase
    .from("facebook_groups")
    .insert({
      workspace_id: ws.id,
      name: parsed.data.name,
      url: parsed.data.url,
      member_count: parsed.data.member_count,
      promo_policy: parsed.data.promo_policy,
      promo_weekdays: parsed.data.promo_weekdays,
      allow_links: parsed.data.allow_links,
      rules_notes: parsed.data.rules_notes,
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error || !data) return { error: error?.message ?? "Could not save the group.", groupId: null };

  revalidatePath("/queue/groups");
  return { error: null, groupId: data.id };
}

export async function updateGroupAction(groupId: string, input: GroupInput): Promise<ActionResult> {
  if (!uuid.safeParse(groupId).success) return { error: "Bad group id." };
  const parsed = groupInputSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid group." };

  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();
  const { error } = await supabase
    .from("facebook_groups")
    .update({
      name: parsed.data.name,
      url: parsed.data.url,
      member_count: parsed.data.member_count,
      promo_policy: parsed.data.promo_policy,
      promo_weekdays: parsed.data.promo_weekdays,
      allow_links: parsed.data.allow_links,
      rules_notes: parsed.data.rules_notes,
    })
    .eq("id", groupId)
    .eq("workspace_id", ws.id);
  if (error) return { error: error.message };

  revalidatePath("/queue/groups");
  return { error: null };
}

export async function deleteGroupAction(groupId: string): Promise<ActionResult> {
  if (!uuid.safeParse(groupId).success) return { error: "Bad group id." };
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();
  // Drafts cascade on delete (FK on delete cascade in migration 040).
  const { error } = await supabase
    .from("facebook_groups")
    .delete()
    .eq("id", groupId)
    .eq("workspace_id", ws.id);
  if (error) return { error: error.message };

  revalidatePath("/queue/groups");
  return { error: null };
}

// ── Drafts ───────────────────────────────────────────────────────────────

const draftTextSchema = z.string().trim().min(1).max(8000);

// Load a group scoped to the active workspace. Shared guard for the draft
// actions so a caller can't attach a draft to another workspace's group.
async function loadGroup(groupId: string) {
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();
  const { data: group } = await supabase
    .from("facebook_groups")
    .select("id, name, promo_policy, promo_weekdays, allow_links, rules_notes")
    .eq("id", groupId)
    .eq("workspace_id", ws.id)
    .maybeSingle();
  return { ws, supabase, group };
}

export async function createManualDraftAction(
  groupId: string,
  text: string,
): Promise<ActionResult & { draftId: string | null }> {
  if (!uuid.safeParse(groupId).success) return { error: "Bad group id.", draftId: null };
  const textParsed = draftTextSchema.safeParse(text);
  if (!textParsed.success) return { error: "Write something first (max 8000 chars).", draftId: null };

  const { ws, supabase, group } = await loadGroup(groupId);
  if (!group) return { error: "Group not found.", draftId: null };
  const user = await getAuthedUserOrRedirect();

  const { data, error } = await supabase
    .from("facebook_group_drafts")
    .insert({
      workspace_id: ws.id,
      group_id: group.id,
      text: textParsed.data,
      source: "manual",
      status: "draft",
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error || !data) return { error: error?.message ?? "Could not save the draft.", draftId: null };

  revalidatePath("/queue/groups");
  return { error: null, draftId: data.id };
}

// Generate N AI drafts for a group from the brand brief + voice + group rules.
// Returns a soft error (not a throw) so the UI can surface it inline.
export async function generateGroupDraftsAction(
  groupId: string,
  count = 3,
): Promise<ActionResult & { created: number }> {
  if (!uuid.safeParse(groupId).success) return { error: "Bad group id.", created: 0 };

  const { ws, supabase, group } = await loadGroup(groupId);
  if (!group) return { error: "Group not found.", created: 0 };
  const user = await getAuthedUserOrRedirect();

  // AI generation needs a brand brief (the voice/product source of truth).
  const { data: brief } = await supabase
    .from("brand_briefs")
    .select("*")
    .eq("workspace_id", ws.id)
    .maybeSingle();
  if (!brief) {
    return {
      error: "Add your business brief first (Settings → Brief) so AI drafts sound like you.",
      created: 0,
    };
  }

  const rules: GroupPostingRules = {
    promo_policy: group.promo_policy as FacebookGroupPromoPolicy,
    promo_weekdays: group.promo_weekdays ?? [],
    allow_links: group.allow_links,
    rules_notes: group.rules_notes ?? "",
  };
  const verdict = postingVerdictNow(rules, new Date(), brief.audience_timezone || "UTC");

  let generated;
  try {
    generated = await generateGroupDrafts({
      brief,
      group: { name: group.name, rules },
      count: Math.max(1, Math.min(5, count)),
      verdictHeadline: verdict.headline,
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "AI generation failed.", created: 0 };
  }

  const rows = generated.drafts.map((d) => ({
    workspace_id: ws.id,
    group_id: group.id,
    text: d.text,
    source: "ai" as const,
    status: "draft" as const,
    created_by: user.id,
  }));
  const { error } = await supabase.from("facebook_group_drafts").insert(rows);
  if (error) return { error: error.message, created: 0 };

  revalidatePath("/queue/groups");
  return { error: null, created: rows.length };
}

export async function updateDraftTextAction(draftId: string, text: string): Promise<ActionResult> {
  if (!uuid.safeParse(draftId).success) return { error: "Bad draft id." };
  const textParsed = draftTextSchema.safeParse(text);
  if (!textParsed.success) return { error: "Draft can't be empty (max 8000 chars)." };

  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();
  const { error } = await supabase
    .from("facebook_group_drafts")
    .update({ text: textParsed.data })
    .eq("id", draftId)
    .eq("workspace_id", ws.id)
    .eq("status", "draft"); // posted/dismissed drafts are immutable
  if (error) return { error: error.message };

  revalidatePath("/queue/groups");
  return { error: null };
}

// Operator self-reports that they pasted & posted this draft. We have no API to
// confirm — this is an honest activity log + dedupe so the same draft doesn't
// linger in the "to post" list.
export async function markDraftPostedAction(draftId: string): Promise<ActionResult> {
  if (!uuid.safeParse(draftId).success) return { error: "Bad draft id." };
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();
  const { error } = await supabase
    .from("facebook_group_drafts")
    .update({ status: "posted", posted_at: new Date().toISOString() })
    .eq("id", draftId)
    .eq("workspace_id", ws.id)
    .eq("status", "draft");
  if (error) return { error: error.message };

  revalidatePath("/queue/groups");
  return { error: null };
}

export async function dismissDraftAction(draftId: string): Promise<ActionResult> {
  if (!uuid.safeParse(draftId).success) return { error: "Bad draft id." };
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();
  const { error } = await supabase
    .from("facebook_group_drafts")
    .update({ status: "dismissed" })
    .eq("id", draftId)
    .eq("workspace_id", ws.id)
    .eq("status", "draft"); // only an active draft can be dismissed (posted/dismissed are terminal)
  if (error) return { error: error.message };

  revalidatePath("/queue/groups");
  return { error: null };
}
