import Link from "next/link";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { isCompetitorWatchEnabled } from "@/lib/billing/feature-gates";
import { EmptyState } from "@/components/ui/empty-state";
import { AddHandleForm } from "./add-handle-form";

export const dynamic = "force-dynamic";

export default async function AddCompetitorPage() {
  const ws = await getActiveWorkspaceOrRedirect();

  if (!isCompetitorWatchEnabled(ws.plan)) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <header className="space-y-1">
          <p className="label-eyebrow">Competitor Watch</p>
          <h1 className="text-3xl font-semibold tracking-tight">Upgrade to add competitors</h1>
        </header>
        <EmptyState
          icon="spark"
          title="Available on the Creator tier."
          description="Competitor Watch tracks handles, surfaces what's working for them, and helps you respond constructively. Upgrade to enable."
          action={
            <Link
              href="/settings/billing"
              className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity duration-200 hover:opacity-90"
            >
              See plans →
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <header className="space-y-1">
        <p className="label-eyebrow">Competitor Watch</p>
        <h1 className="text-3xl font-semibold tracking-tight">Add a handle to watch</h1>
        <p className="text-sm text-muted-foreground">
          We pull public posts daily, flag the top 10% per account as &ldquo;winners,&rdquo;
          and tag the structural pattern. Read-only — never adversarial.
        </p>
      </header>
      <AddHandleForm />
    </div>
  );
}
