import Link from "next/link";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { EmptyState } from "@/components/ui/empty-state";
import { BuildInPublicForm } from "./build-in-public-form";

export const dynamic = "force-dynamic";

// /sources/build-in-public — paste your raw build updates, get a week of
// build-in-public posts in your voice, led by X, dropped into your queue.
export default async function BuildInPublicPage() {
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();
  const { data: brief } = await supabase
    .from("brand_briefs")
    .select("id")
    .eq("workspace_id", ws.id)
    .maybeSingle();

  // A brand brief anchors voice + audience — the planner needs it to make the
  // posts sound like you, not a press release. Surface the prereq here rather
  // than letting a founder paste updates they can't turn into anything.
  if (!brief) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <header className="space-y-1">
          <p className="label-eyebrow">Build in public</p>
          <h1 className="text-3xl font-semibold tracking-tight">One step first: your brief</h1>
        </header>
        <EmptyState
          icon="doc"
          title="Add a brand brief."
          description="It’s 2 minutes. We read it to write build-in-public posts that sound like you — not a marketing team."
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
      <header className="space-y-2">
        <p className="label-eyebrow">Build in public</p>
        <h1 className="text-3xl font-semibold tracking-tight">Turn your build into posts</h1>
        <p className="text-sm text-muted-foreground">
          You shipped all week — now tell people. Paste your changelog, launch notes, or a quick
          brain-dump and get a week of honest build-in-public posts in your voice, led by X. Edit
          anything before it goes out.
        </p>
      </header>
      <BuildInPublicForm />
    </div>
  );
}
