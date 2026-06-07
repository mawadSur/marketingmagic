import { NextResponse, type NextRequest } from "next/server";
import { serverEnv } from "@/lib/env";
import { supabaseService } from "@/lib/supabase/service";
import { resolveTheme, type ResolvedTheme } from "@/lib/portal/branding";
import type { PortalBranding } from "@/lib/portal/data";
import { assembleMonthlyReport } from "@/lib/client-report/assemble";
import { renderMonthlyReportHtml } from "@/lib/client-report/report-html";

// Branded monthly proof-of-work client report (Agency Proof Engine, bet ③).
//
// For each CLIENT workspace (organization_id NOT NULL) under an org, assembles a
// monthly report — posts shipped, reach/impressions, engagement, top themes, and
// outcome/$ data when available — renders it white-labeled with the ORG's
// branding (logo/colors from migration 033), and emails it via Resend.
//
// Auth: Bearer CRON_SECRET (EXACT same shape as the sibling crons —
// engagement-report / email-digest). Runs monthly (1st of the month) from
// .github/workflows/cron-client-report.yml; reports the PREVIOUS calendar month.
//
// Service-role Supabase throughout — RLS would block reads across workspaces.
// Recipient resolution: client-contact emails recorded in client_invites for the
// workspace, falling back to the workspace owner (mirrors the digest crons).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESEND_URL = "https://api.resend.com/emails";

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}

function authorized(req: NextRequest): boolean {
  const env = serverEnv();
  const header = req.headers.get("authorization") ?? "";
  if (env.CRON_SECRET && header === `Bearer ${env.CRON_SECRET}`) return true;
  const qs = req.nextUrl.searchParams.get("secret");
  return Boolean(env.CRON_SECRET) && qs === env.CRON_SECRET;
}

interface ReportResult {
  workspaceId: string;
  workspaceName: string;
  status: "sent" | "skipped" | "failed";
  recipients?: string[];
  quietMonth?: boolean;
  outcomesEnabled?: boolean;
  reason?: string;
}

async function handle(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const env = serverEnv();
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
    return NextResponse.json(
      { error: "email transport not configured (need RESEND_API_KEY + EMAIL_FROM)" },
      { status: 200 },
    );
  }

  const svc = supabaseService();
  const now = new Date();

  // 1. Client workspaces = those attached to an org. Solo workspaces
  //    (organization_id NULL) are NOT agency clients, so they're excluded.
  const { data: workspaces, error: wsErr } = await svc
    .from("workspaces")
    .select("id, name, owner_id, organization_id")
    .not("organization_id", "is", null);
  if (wsErr) {
    return NextResponse.json({ error: wsErr.message }, { status: 500 });
  }
  const clientWorkspaces = workspaces ?? [];
  if (clientWorkspaces.length === 0) {
    return NextResponse.json({ checked: 0, sent: 0, reason: "no client workspaces" });
  }

  // 2. Org branding (logo/colors) — one fetch keyed by org id, reused per
  //    workspace. Resolving via the org gives the agency white-label.
  const orgIds = Array.from(
    new Set(clientWorkspaces.map((w) => w.organization_id).filter((id): id is string => !!id)),
  );
  const { data: orgs } = await svc
    .from("organizations")
    .select("id, name, logo_url, color_primary, color_accent")
    .in("id", orgIds);
  const orgById = new Map((orgs ?? []).map((o) => [o.id, o]));

  let sent = 0;
  const results: ReportResult[] = [];

  for (const ws of clientWorkspaces) {
    const result: ReportResult = {
      workspaceId: ws.id,
      workspaceName: ws.name,
      status: "skipped",
    };

    try {
      // Assemble + render. Cold-start (zero posts/outcomes) yields a graceful
      // quiet-month report, never empty/broken.
      const report = await assembleMonthlyReport(ws.id, now);
      result.quietMonth = report.quietMonth;
      result.outcomesEnabled = report.outcomes.enabled;

      const org = ws.organization_id ? orgById.get(ws.organization_id) : undefined;
      const branding: PortalBranding = {
        workspaceName: ws.name,
        organizationName: org?.name ?? null,
        logoUrl: org?.logo_url ?? null,
        colorPrimary: org?.color_primary ?? null,
        colorAccent: org?.color_accent ?? null,
      };
      const theme: ResolvedTheme = resolveTheme(branding);

      const html = renderMonthlyReportHtml({
        theme,
        workspaceName: ws.name,
        report,
        generatedAt: now,
      });

      // Recipients: client-contact emails from client_invites for this
      // workspace; fall back to the workspace owner if there are none.
      const recipients = await resolveRecipients(ws.id, ws.owner_id);
      if (recipients.length === 0) {
        result.status = "skipped";
        result.reason = "no recipient (no client invites + owner has no email)";
        results.push(result);
        continue;
      }
      result.recipients = recipients;

      const subject = `Your ${report.month.label} report — ${theme.brandName}`;
      const resp = await fetch(RESEND_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ from: env.EMAIL_FROM, to: recipients, subject, html }),
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        result.status = "failed";
        result.reason = `resend ${resp.status}: ${errText.slice(0, 200)}`;
      } else {
        result.status = "sent";
        sent += 1;
      }
    } catch (err) {
      result.status = "failed";
      result.reason = err instanceof Error ? err.message : "report assembly failed";
    }

    results.push(result);
  }

  return NextResponse.json({
    checked: clientWorkspaces.length,
    sent,
    results,
    at: now.toISOString(),
  });
}

// Client-contact emails for the workspace (from the client_invites audit trail),
// falling back to the workspace owner's email. Deduped + lowercased.
async function resolveRecipients(workspaceId: string, ownerId: string): Promise<string[]> {
  const svc = supabaseService();

  const { data: invites } = await svc
    .from("client_invites")
    .select("recipient_email")
    .eq("workspace_id", workspaceId);

  const emails = new Set<string>();
  for (const row of invites ?? []) {
    const e = row.recipient_email?.trim().toLowerCase();
    if (e) emails.add(e);
  }

  if (emails.size === 0) {
    const { data: userResp } = await svc.auth.admin.getUserById(ownerId);
    const ownerEmail = userResp?.user?.email?.trim().toLowerCase();
    if (ownerEmail) emails.add(ownerEmail);
  }

  return Array.from(emails);
}
