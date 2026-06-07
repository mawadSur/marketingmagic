import Link from "next/link";
import { getAuthedUserOrRedirect, listOrganizations, listClientWorkspaces } from "@/lib/workspace";
import { listPortalTokens } from "@/lib/portal/manage";
import { listSelfConnectTokens } from "@/lib/client-connect/token";
import { EmptyState } from "@/components/ui/empty-state";
import { BrandingForm, PortalLinksManager } from "./branding-forms";
import { SelfConnectLinksManager } from "./self-connect-forms";

export const dynamic = "force-dynamic";

/**
 * /settings/organization/branding — Phase E white-label + client portal links.
 *
 * Owner-only surface (the page still renders for members but the actions reject
 * non-owners). Lets the agency owner set logo + colors that brand the client
 * portal and report PDF, and mint/revoke per-client portal links.
 *
 * NOTE: deliberately a child route of /settings/organization, not the org index
 * page (billing edits live nearby on the index).
 */
export default async function OrganizationBrandingPage() {
  const user = await getAuthedUserOrRedirect();
  const orgs = await listOrganizations();
  const org = orgs[0] ?? null;

  if (!org) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <Link
          href="/settings/organization"
          className="inline-block text-sm text-muted-foreground hover:text-foreground"
        >
          ← Organization
        </Link>
        <header className="space-y-1">
          <p className="label-eyebrow">Settings</p>
          <h1 className="text-2xl font-semibold tracking-tight">Branding &amp; portal</h1>
        </header>
        <EmptyState
          icon="inbox"
          title="No organization yet."
          description="Create an organization first, then you can white-label the client portal and share links."
          action={
            <Link
              href="/settings/organization"
              className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Go to organization
            </Link>
          }
        />
      </div>
    );
  }

  const isOwner = org.owner_id === user.id;
  const clients = await listClientWorkspaces(org.id);

  // Portal tokens per client workspace, for the management list. listPortalTokens
  // is scoped to each workspace id (which we got from listClientWorkspaces — all
  // in this org via RLS).
  const tokensByWorkspace = await Promise.all(
    clients.map(async (c) => ({ workspace: c, tokens: await listPortalTokens(c.id) })),
  );

  // Self-connect tokens per client workspace, for the self-connect management
  // list. Same RLS-scoped read as the portal tokens above — listSelfConnectTokens
  // is scoped to each client workspace id (all in this org via RLS).
  const selfConnectByWorkspace = await Promise.all(
    clients.map(async (c) => ({ workspace: c, tokens: await listSelfConnectTokens(c.id) })),
  );

  return (
    <div className="mx-auto max-w-3xl space-y-10">
      <Link
        href="/settings/organization"
        className="inline-block text-sm text-muted-foreground hover:text-foreground"
      >
        ← Organization
      </Link>
      <header className="space-y-1">
        <p className="label-eyebrow">Settings · {org.name}</p>
        <h1 className="text-2xl font-semibold tracking-tight">Branding &amp; portal</h1>
        <p className="text-sm text-muted-foreground">
          White-label the client portal and report PDFs with your logo and colors, and
          create shareable approval/report links for each client.
        </p>
      </header>

      {!isOwner ? (
        <p className="rounded-lg border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          Only the organization owner can change branding or manage portal links.
        </p>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-base font-medium">White-label</h2>
        <div className="rounded-lg border bg-card p-5">
          <BrandingForm
            organizationId={org.id}
            disabled={!isOwner}
            initial={{
              logoUrl: org.logo_url,
              colorPrimary: org.color_primary,
              colorAccent: org.color_accent,
            }}
          />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-medium">Client portal links</h2>
        {clients.length === 0 ? (
          <EmptyState
            icon="inbox"
            title="No client workspaces yet."
            description="Add a client on the organization page, then mint a portal link for them here."
          />
        ) : (
          <PortalLinksManager
            organizationId={org.id}
            disabled={!isOwner}
            clients={tokensByWorkspace.map(({ workspace, tokens }) => ({
              workspaceId: workspace.id,
              workspaceName: workspace.name,
              tokens: tokens.map((t) => ({
                id: t.id,
                label: t.label,
                scopes: t.scopes,
                expiresAt: t.expires_at,
                revokedAt: t.revoked_at,
                createdAt: t.created_at,
              })),
            }))}
          />
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-medium">Client self-connect links</h2>
        <p className="text-sm text-muted-foreground">
          Send a client a link they use to connect their own social accounts — no
          password handoff. They sign in with each network directly.
        </p>
        {clients.length === 0 ? (
          <EmptyState
            icon="inbox"
            title="No client workspaces yet."
            description="Add a client on the organization page, then generate a self-connect link for them here."
          />
        ) : (
          <SelfConnectLinksManager
            organizationId={org.id}
            disabled={!isOwner}
            clients={selfConnectByWorkspace.map(({ workspace, tokens }) => ({
              workspaceId: workspace.id,
              workspaceName: workspace.name,
              tokens: tokens.map((t) => ({
                id: t.id,
                label: t.label,
                expiresAt: t.expires_at,
                revokedAt: t.revoked_at,
                createdAt: t.created_at,
              })),
            }))}
          />
        )}
      </section>
    </div>
  );
}
