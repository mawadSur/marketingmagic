import Link from "next/link";
import Image from "next/image";
import { resolvePortalToken, hasScope } from "@/lib/portal/token";
import {
  getPortalBranding,
  listPendingPosts,
  getPortalReport,
  getPortalInsights,
} from "@/lib/portal/data";
import { resolveTheme } from "@/lib/portal/branding";
import { PortalApprovals } from "./portal-approvals";
import { PortalReport } from "./portal-report";

export const dynamic = "force-dynamic";

// /client/[token] — the unauthenticated client portal landing page.
//
// Resolves the raw token to a validated context (workspace + scopes). An
// invalid/expired/revoked token renders a single generic "invalid link" page —
// we never reveal which condition failed, nor anything about the workspace.
export default async function ClientPortalPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const ctx = await resolvePortalToken(token);

  if (!ctx) {
    return <InvalidLink />;
  }

  const branding = await getPortalBranding(ctx);
  const theme = resolveTheme(branding);

  const canApprove = hasScope(ctx, "approve");
  const canViewReports = hasScope(ctx, "view_reports");

  const [pending, report, insights] = await Promise.all([
    canApprove ? listPendingPosts(ctx) : Promise.resolve([]),
    canViewReports ? getPortalReport(ctx) : Promise.resolve(null),
    canViewReports ? getPortalInsights(ctx) : Promise.resolve(null),
  ]);

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <header
        className="mb-8 flex items-center gap-4 border-b pb-6"
        style={{ borderColor: theme.accent }}
      >
        {theme.logoUrl ? (
          <Image
            src={theme.logoUrl}
            alt={theme.brandName}
            width={48}
            height={48}
            className="h-12 w-12 rounded-md object-contain"
            unoptimized
          />
        ) : (
          <div
            className="flex h-12 w-12 items-center justify-center rounded-md text-lg font-semibold text-white"
            style={{ backgroundColor: theme.accent }}
          >
            {theme.brandName.slice(0, 1).toUpperCase()}
          </div>
        )}
        <div>
          <h1 className="text-xl font-semibold tracking-tight" style={{ color: theme.primary }}>
            {theme.brandName}
          </h1>
          <p className="text-sm text-muted-foreground">{branding.workspaceName} · Client portal</p>
        </div>
      </header>

      {canApprove ? (
        <section className="mb-10 space-y-4">
          <h2 className="text-base font-medium">Pending your approval</h2>
          <PortalApprovals token={token} posts={pending} accent={theme.accent} />
        </section>
      ) : null}

      {canViewReports && report ? (
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-medium">Performance</h2>
            <Link
              href={`/client/${token}/report`}
              className="text-sm font-medium underline-offset-4 hover:underline"
              style={{ color: theme.accent }}
              prefetch={false}
            >
              Download PDF
            </Link>
          </div>
          <PortalReport report={report} insights={insights} accent={theme.accent} />
        </section>
      ) : null}

      {!canApprove && !canViewReports ? (
        <p className="rounded-lg border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
          This link doesn&apos;t have any sections enabled. Ask your account manager to
          update its permissions.
        </p>
      ) : null}
    </main>
  );
}

function InvalidLink() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-4 text-center">
      <h1 className="text-lg font-semibold">This link isn&apos;t valid</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        It may have expired or been turned off. Ask your account manager for a fresh link.
      </p>
    </main>
  );
}
