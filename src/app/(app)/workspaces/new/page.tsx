import Link from "next/link";
import { Sparkles } from "lucide-react";
import { getAuthedUserOrRedirect } from "@/lib/workspace";
import { supabaseService } from "@/lib/supabase/service";
import { resolveWorkspaceCreationGate } from "@/lib/billing/entitlements";
import { Button } from "@/components/ui/button";
import { NewWorkspaceForm } from "./new-workspace-form";

export const dynamic = "force-dynamic";

export default async function NewWorkspacePage() {
  const user = await getAuthedUserOrRedirect();

  // Paywall gate. The Free plan includes one workspace; creating MORE needs a
  // paid plan (or an org). We resolve here so a free user sees the upgrade
  // paywall instead of a form that the server action would only reject anyway.
  // (The action re-checks — this page guard is UX, not the security boundary.)
  const gate = await resolveWorkspaceCreationGate(user.id, supabaseService());

  if (!gate.allowed) {
    return (
      <div className="mx-auto max-w-md space-y-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">New workspace</h1>
          <p className="text-sm text-muted-foreground">
            Workspaces are isolated tenants. Brand briefs, posts, and channels never leak between
            them.
          </p>
        </header>

        <div className="space-y-4 rounded-lg border border-amber-500/40 bg-amber-500/5 p-5">
          <div className="flex items-start gap-2">
            <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" aria-hidden />
            <div className="space-y-1">
              <p className="font-medium">Multiple workspaces are a paid feature.</p>
              <p className="text-sm text-muted-foreground">
                The Free plan includes one workspace. Upgrade to a paid plan to run multiple
                brands — and your subscription covers all of them.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link href="/settings/billing">Upgrade plan</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/pricing">See plans</Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">New workspace</h1>
        <p className="text-sm text-muted-foreground">
          Workspaces are isolated tenants. Brand briefs, posts, and channels never leak between them.
        </p>
      </header>
      <NewWorkspaceForm />
    </div>
  );
}
