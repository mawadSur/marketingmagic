"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { slugify } from "@/lib/slug";
import { setActiveWorkspaceCookie } from "@/lib/workspace";
import { attributeWorkspaceCreation } from "@/lib/growth/referrals";

export type CreateWorkspaceState = { error: string | null };

const schema = z.object({ name: z.string().trim().min(2).max(60) });

export async function createWorkspaceAction(
  _prev: CreateWorkspaceState,
  formData: FormData,
): Promise<CreateWorkspaceState> {
  const parsed = schema.safeParse({ name: formData.get("name") });
  if (!parsed.success) return { error: "Pick a name between 2 and 60 characters." };

  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You must be signed in." };

  const baseSlug = slugify(parsed.data.name) || "workspace";
  const slug = await uniqueSlug(baseSlug);

  const { data: created, error } = await supabase
    .from("workspaces")
    .insert({
      name: parsed.data.name,
      slug,
      owner_id: user.id,
    })
    .select("id")
    .single();
  if (error || !created) return { error: error?.message ?? "Could not create workspace." };

  // PLG: attribute this workspace to a referrer if the visitor arrived with a
  // ?ref code at signup. No-op when there's no pending ref / unknown code /
  // self-referral; never throws (a growth side-effect must not block
  // onboarding).
  await attributeWorkspaceCreation(created.id);

  await setActiveWorkspaceCookie(slug);
  // First-time setup: channels come before brief — without a connected
  // channel the rest of the wizard (brief, plan) has nothing to publish to.
  redirect("/onboarding/wizard?step=2");
}

async function uniqueSlug(base: string): Promise<string> {
  const svc = supabaseService();
  let candidate = base;
  for (let i = 0; i < 25; i++) {
    const { data } = await svc.from("workspaces").select("id").eq("slug", candidate).maybeSingle();
    if (!data) return candidate;
    candidate = `${base}-${Math.floor(Math.random() * 1000)}`;
  }
  return `${base}-${Date.now().toString(36)}`;
}
