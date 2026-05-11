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
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Brand brief</h1>
        <p className="text-sm text-muted-foreground">
          The brief is the input every plan and event-driven post is generated from. Keep it sharp.
        </p>
      </header>
      <BriefForm initial={brief ?? null} />
    </div>
  );
}
