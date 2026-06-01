import { resolvePortalToken, hasScope } from "@/lib/portal/token";
import { getPortalBranding, getPortalReport, getPortalInsights } from "@/lib/portal/data";
import { resolveTheme } from "@/lib/portal/branding";
import { renderReportHtml } from "@/lib/portal/report-html";

export const dynamic = "force-dynamic";

// GET /client/[token]/report — white-labeled, print-to-PDF performance report.
//
// SECURITY: re-resolves the raw token on every request (validates revoked /
// expired) and hard-gates on the 'view_reports' scope before any data read. A
// token without the scope gets a 403, never the data.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const ctx = await resolvePortalToken(token);
  if (!ctx) {
    return new Response("This link is no longer valid.", { status: 404 });
  }
  if (!hasScope(ctx, "view_reports")) {
    return new Response("This link cannot view reports.", { status: 403 });
  }

  const [branding, report, insights] = await Promise.all([
    getPortalBranding(ctx),
    getPortalReport(ctx),
    getPortalInsights(ctx),
  ]);
  const theme = resolveTheme(branding);

  const html = renderReportHtml({
    theme,
    workspaceName: branding.workspaceName,
    report,
    insights,
    generatedAt: new Date(),
  });

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Don't cache a tenant-scoped, token-bearing document anywhere.
      "cache-control": "no-store, private",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}
