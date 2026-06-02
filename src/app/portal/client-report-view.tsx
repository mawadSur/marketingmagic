import Image from "next/image";
import Link from "next/link";
import { resolveTheme } from "@/lib/portal/branding";
import { PortalReport } from "@/app/client/[token]/portal-report";
import type { ClientWorkspaceReport } from "@/lib/portal/account";

// Presentational report view for the AUTHENTICATED client portal. Reuses the
// same white-label theming + the same PortalReport table the tokenized portal
// renders, so the account view and the token portal are pixel-for-pixel the
// same report. READ-ONLY: there are no actions, no approve/edit controls —
// clients can only look.
export function ClientReportView({
  data,
  showSwitchLink,
}: {
  data: ClientWorkspaceReport;
  showSwitchLink: boolean;
}) {
  const theme = resolveTheme(data.branding);

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
        <div className="flex-1">
          <h1 className="text-xl font-semibold tracking-tight" style={{ color: theme.primary }}>
            {theme.brandName}
          </h1>
          <p className="text-sm text-muted-foreground">
            {data.branding.workspaceName} · Your report
          </p>
        </div>
        {showSwitchLink ? (
          <Link
            href="/portal"
            className="text-sm font-medium underline-offset-4 hover:underline"
            style={{ color: theme.accent }}
            prefetch={false}
          >
            Switch workspace
          </Link>
        ) : null}
      </header>

      <section className="space-y-4">
        <h2 className="text-base font-medium">Performance</h2>
        <PortalReport
          report={data.report}
          insights={{ channels: data.channels, winningThemes: data.winningThemes }}
          accent={theme.accent}
        />
      </section>
    </main>
  );
}
