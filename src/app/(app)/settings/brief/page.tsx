import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { BriefForm } from "./brief-form";

export const dynamic = "force-dynamic";

export default async function BriefPage() {
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();
  const { data: brief } = await supabase
    .from("brand_briefs")
    .select("*")
    .eq("workspace_id", ws.id)
    .maybeSingle();

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <header className="space-y-1">
        <p className="label-eyebrow">Settings</p>
        <h1 className="text-3xl font-semibold tracking-tight">Brand brief</h1>
        <p className="text-sm text-muted-foreground">
          The brief feeds every generated post. Keep it sharp — vague briefs produce vague posts.
        </p>
      </header>
      <BriefForm initial={brief ?? null} />
    </div>
  );
}
