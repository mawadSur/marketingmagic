import Link from "next/link";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { ENABLED_CHANNELS } from "@/lib/channels/registry";
import { EmptyState } from "@/components/ui/empty-state";
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
      <PreflightWrapper title="One step first: write a brief">
        <EmptyState
          icon="doc"
          title="Add a brand brief."
          description="Claude reads the brief to nail voice, audience, and the things you don't say."
          action={
            <Link
              href="/settings/brief"
              className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity duration-200 hover:opacity-90"
            >
              Write your brief →
            </Link>
          }
        />
      </PreflightWrapper>
    );
  }
  if (accounts.length === 0) {
    return (
      <PreflightWrapper title="Connect a channel first">
        <EmptyState
          icon="plug"
          title="No channels connected."
          description="Hook up at least one social account so plans have somewhere to ship."
          action={
            <Link
              href="/settings/channels"
              className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity duration-200 hover:opacity-90"
            >
              Connect a channel →
            </Link>
          }
        />
      </PreflightWrapper>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <header className="space-y-1">
        <p className="label-eyebrow">New plan</p>
        <h1 className="text-3xl font-semibold tracking-tight">Generate a plan</h1>
        <p className="text-sm text-muted-foreground">
          Pick channels and cadence. Claude drafts every post — they land in the queue as pending approval
          (or auto-scheduled for accounts in trust mode).
        </p>
      </header>
      <NewPlanForm accounts={accounts} />
    </div>
  );
}

function PreflightWrapper({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="space-y-1">
        <p className="label-eyebrow">New plan</p>
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      </header>
      {children}
    </div>
  );
}
