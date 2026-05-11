import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";

export default async function DashboardPage() {
  const ws = await getActiveWorkspaceOrRedirect();
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{ws.name}</h1>
        <p className="text-sm text-muted-foreground">
          Auto-generated posting plans, hybrid-approval auto-posting, data-driven theme iteration.
        </p>
      </header>
      <div className="rounded-lg border p-6 text-sm text-muted-foreground">
        Dashboard KPIs land in V1-12. Until then, jump straight to your{" "}
        <a className="text-primary underline-offset-4 hover:underline" href="/plans">
          plans
        </a>{" "}
        or the{" "}
        <a className="text-primary underline-offset-4 hover:underline" href="/queue">
          approval queue
        </a>
        .
      </div>
    </div>
  );
}
