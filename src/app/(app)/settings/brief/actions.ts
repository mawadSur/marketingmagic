"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";

export type SaveBriefState = { error: string | null; savedAt: string | null };

const schema = z.object({
  product_description: z.string().trim().min(10).max(4000),
  voice: z.string().trim().min(10).max(4000),
  target_audience: z.string().trim().min(5).max(2000),
  do_not_say: z.array(z.string().trim().min(1)).max(50),
  reference_links: z.array(z.string().url()).max(20),
  reference_posts: z.array(z.string().trim().min(1)).max(50),
});

function lines(value: FormDataEntryValue | null): string[] {
  if (typeof value !== "string") return [];
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function saveBriefAction(
  _prev: SaveBriefState,
  formData: FormData,
): Promise<SaveBriefState> {
  const ws = await getActiveWorkspaceOrRedirect();
  const parsed = schema.safeParse({
    product_description: (formData.get("product_description") as string) ?? "",
    voice: (formData.get("voice") as string) ?? "",
    target_audience: (formData.get("target_audience") as string) ?? "",
    do_not_say: lines(formData.get("do_not_say")),
    reference_links: lines(formData.get("reference_links")),
    reference_posts: lines(formData.get("reference_posts")),
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
      savedAt: null,
    };
  }

  const supabase = await supabaseServer();
  const { error } = await supabase
    .from("brand_briefs")
    .upsert(
      { workspace_id: ws.id, ...parsed.data },
      { onConflict: "workspace_id" },
    );
  if (error) return { error: error.message, savedAt: null };

  revalidatePath("/settings/brief");
  return { error: null, savedAt: new Date().toISOString() };
}
