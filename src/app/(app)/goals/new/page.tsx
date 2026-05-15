import Link from "next/link";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { EmptyState } from "@/components/ui/empty-state";
import { GoalForm } from "./goal-form";

export const dynamic = "force-dynamic";

// /goals/new — the structured questionnaire. Server component guards the
// brief prereq (the reverse-planner reads voice + brand context); when
// missing we redirect-style nudge the user to /settings/brief, same as
// /sources/new does.
export default async function NewGoalPage() {
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();
  const { data: brief } = await supabase
    .from("brand_briefs")
    .select("id")
    .eq("workspace_id", ws.id)
    .maybeSingle();

  if (!brief) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <header className="space-y-1">
          <p className="label-eyebrow">New goal</p>
          <h1 className="text-3xl font-semibold tracking-tight">One step first: write a brief</h1>
        </header>
        <EmptyState
          icon="doc"
          title="Add a brand brief."
          description="The strategist reads your brief — voice, audience, product — before proposing a plan to hit your goal."
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
        <p className="label-eyebrow">New goal</p>
        <h1 className="text-3xl font-semibold tracking-tight">State your goal</h1>
        <p className="text-sm text-muted-foreground">
          Pick a metric, set a target, describe the goal in your own words. The strategist
          proposes a plan; you approve before any posts get generated.
        </p>
      </header>
      <GoalForm />
    </div>
  );
}
