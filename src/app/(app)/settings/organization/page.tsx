import { getAuthedUserOrRedirect, listOrganizations, listClientWorkspaces } from "@/lib/workspace";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { switchWorkspaceAction } from "@/app/(app)/workspace-actions";
import { CreateOrganizationForm, AddClientForm } from "./org-forms";

export const dynamic = "force-dynamic";

/**
 * /settings/organization — agency layer (Phase A, migration 029).
 *
 * No org yet → promote the user to create one (solo workspaces are untouched).
 * Org exists → show its details, an "add a client" form, and the list of
 * client workspaces. Switching to a client is the same cookie-backed action
 * the header switcher uses; client workspaces also appear there automatically
 * because listWorkspaces() returns every workspace RLS lets the caller read.
 */
export default async function OrganizationPage() {
  const user = await getAuthedUserOrRedirect();
  const orgs = await listOrganizations();

  // First org the user owns or belongs to. Multi-org switching is a later
  // refinement; Phase A scopes to a single active org per user.
  const org = orgs[0] ?? null;

  if (!org) {
    return (
      <div className="mx-auto max-w-3xl space-y-10">
        <header className="space-y-1">
          <p className="label-eyebrow">Settings</p>
          <h1 className="text-2xl font-semibold tracking-tight">Organization</h1>
          <p className="text-sm text-muted-foreground">
            Running social for multiple clients? Create an organization to manage
            many client workspaces under one agency — billed once, with shared
            staff access. Your existing solo workspaces stay exactly as they are.
          </p>
        </header>
        <section className="space-y-3">
          <h2 className="text-base font-medium">Create your agency</h2>
          <div className="rounded-lg border bg-card p-5">
            <CreateOrganizationForm />
          </div>
        </section>
      </div>
    );
  }

  const clients = await listClientWorkspaces(org.id);
  const isOwner = org.owner_id === user.id;

  return (
    <div className="mx-auto max-w-3xl space-y-10">
      <header className="space-y-1">
        <p className="label-eyebrow">Settings</p>
        <h1 className="text-2xl font-semibold tracking-tight">{org.name}</h1>
        <p className="text-sm text-muted-foreground">
          Agency workspace on the <strong>{org.plan}</strong> plan. Add client
          workspaces below; each one is a fully isolated tenant your staff can
          switch between from the header.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-base font-medium">Add a client</h2>
        <div className="rounded-lg border bg-card p-5">
          <AddClientForm organizationId={org.id} />
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-base font-medium">Client workspaces</h2>
          <p className="text-xs text-muted-foreground">
            {clients.length} {clients.length === 1 ? "client" : "clients"}
          </p>
        </div>
        {clients.length === 0 ? (
          <EmptyState
            icon="inbox"
            title="No client workspaces yet."
            description="Add your first client above to start managing their channels and posts."
          />
        ) : (
          <ul className="space-y-2">
            {clients.map((c) => (
              <li
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{c.name}</p>
                  <p className="text-xs text-muted-foreground">/{c.slug}</p>
                </div>
                <div className="flex items-center gap-3">
                  <Badge variant="muted">{c.plan}</Badge>
                  <form
                    action={async () => {
                      "use server";
                      await switchWorkspaceAction(c.slug);
                    }}
                  >
                    <button
                      type="submit"
                      className="rounded-md px-2 py-1 text-xs text-foreground hover:bg-muted"
                    >
                      Switch to
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {!isOwner ? (
        <p className="text-xs text-muted-foreground">
          You&apos;re a member of this organization. Only the owner can change
          billing and branding.
        </p>
      ) : null}
    </div>
  );
}
