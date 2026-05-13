"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { slugify } from "@/lib/slug";
import { setActiveWorkspaceCookie } from "@/lib/workspace";

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

  const { error } = await supabase.from("workspaces").insert({
    name: parsed.data.name,
    slug,
    owner_id: user.id,
  });
  if (error) return { error: error.message };

  await setActiveWorkspaceCookie(slug);
  // First-time setup: walk the user through brief → channel → plan instead
  // of dumping them on an empty dashboard.
  redirect("/onboarding/wizard?step=1");
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
