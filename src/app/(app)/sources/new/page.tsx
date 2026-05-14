import Link from "next/link";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { EmptyState } from "@/components/ui/empty-state";
import { NewSourceForm } from "./new-source-form";

export const dynamic = "force-dynamic";

export default async function NewSourcePage() {
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();
  const { data: brief } = await supabase
    .from("brand_briefs")
    .select("id")
    .eq("workspace_id", ws.id)
    .maybeSingle();

  // The source detail page needs a brand brief to generate a cluster, so
  // we surface the brief-prereq here too rather than letting the user
  // ingest a source they can't act on. Mirrors the /plans/new flow.
  if (!brief) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <header className="space-y-1">
          <p className="label-eyebrow">New source</p>
          <h1 className="text-3xl font-semibold tracking-tight">One step first: write a brief</h1>
        </header>
        <EmptyState
          icon="doc"
          title="Add a brand brief."
          description="Claude reads the brief to nail voice and audience before turning a source into posts."
          action={
            <Link
              href="/settings/brief"
              className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity duration-200 hover:opacity-90"
            >
              Write your brief →
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <header className="space-y-1">
        <p className="label-eyebrow">New source</p>
        <h1 className="text-3xl font-semibold tracking-tight">Add a source</h1>
        <p className="text-sm text-muted-foreground">
          Paste a URL or a transcript. Claude pulls themes, quotes, and facts. Cluster generation
          is a separate step on the next screen.
        </p>
      </header>
      <NewSourceForm />
    </div>
  );
}
