import Link from "next/link";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { NewPlanForm } from "./new-plan-form";

export const dynamic = "force-dynamic";

export default async function NewPlanPage() {
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();
  const [briefRes, accountsRes] = await Promise.all([
    supabase.from("brand_briefs").select("id").eq("workspace_id", ws.id).maybeSingle(),
    supabase
      .from("social_accounts_safe")
      .select("id, channel, handle")
      .eq("workspace_id", ws.id)
      .eq("status", "connected"),
  ]);

  const accounts = accountsRes.data ?? [];
  const xAccounts = accounts.filter((a) => a.channel === "x");

  if (!briefRes.data) {
    return (
      <PreflightBlock title="Add a brand brief first">
        The plan generator reads the brief to capture voice and audience.{" "}
        <Link href="/settings/brief" className="text-primary underline-offset-4 hover:underline">
          Write your brief →
        </Link>
      </PreflightBlock>
    );
  }
  if (xAccounts.length === 0) {
    return (
      <PreflightBlock title="Connect a channel first">
        V0 only ships X. Add an X account before generating a plan.{" "}
        <Link href="/settings/channels/x" className="text-primary underline-offset-4 hover:underline">
          Connect X →
        </Link>
      </PreflightBlock>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Generate a plan</h1>
        <p className="text-sm text-muted-foreground">
          Claude reads your brief, picks themes, and drafts every post. They land in the queue as
          pending approval.
        </p>
      </header>
      <NewPlanForm xAccounts={xAccounts} />
    </div>
  );
}

function PreflightBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl space-y-3">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  );
}
