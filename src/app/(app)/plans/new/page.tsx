import Link from "next/link";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { ENABLED_CHANNELS } from "@/lib/channels/registry";
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
      .eq("status", "connected")
      .order("created_at", { ascending: true }),
  ]);

  const accounts = (accountsRes.data ?? []).filter((a) =>
    ENABLED_CHANNELS.includes(a.channel as (typeof ENABLED_CHANNELS)[number]),
  );

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
  if (accounts.length === 0) {
    return (
      <PreflightBlock title="Connect a channel first">
        Add at least one social account before generating a plan.{" "}
        <Link href="/settings/channels" className="text-primary underline-offset-4 hover:underline">
          Connect a channel →
        </Link>
      </PreflightBlock>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Generate a plan</h1>
        <p className="text-sm text-muted-foreground">
          Pick which channels to include and how often to post on each. Claude drafts every post; they
          land in the queue as pending approval (or auto-scheduled for accounts in trust mode).
        </p>
      </header>
      <NewPlanForm accounts={accounts} />
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
