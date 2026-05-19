import { redirect } from "next/navigation";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseService } from "@/lib/supabase/service";
import { Button } from "@/components/ui/button";
import type { LinkedInCredentials } from "@/lib/social/linkedin";
import { selectLinkedInTargetAction } from "./actions";

// Post-OAuth org picker. Reached only when the LinkedIn OAuth callback
// found organizations the user administers AND `w_organization_social`
// was granted. Otherwise the callback redirects straight to
// /settings/channels?connected=linkedin and this page never renders.

export const dynamic = "force-dynamic";

interface SelectTargetProps {
  searchParams: Promise<{ account?: string; orgs?: string }>;
}

interface OrgChoice {
  urn: string;
  name: string;
}

export default async function LinkedInSelectTargetPage({ searchParams }: SelectTargetProps) {
  const params = await searchParams;
  const ws = await getActiveWorkspaceOrRedirect();
  const accountId = params.account;
  if (!accountId) redirect("/settings/channels");

  // Service-role read: we just upserted this row in the OAuth callback,
  // ws membership is already verified by the active-workspace middleware,
  // and we only show its handle + persisted member URN to the operator.
  const svc = supabaseService();
  const { data: acct } = await svc
    .from("social_accounts")
    .select("id, handle, workspace_id, credentials")
    .eq("id", accountId)
    .maybeSingle();
  if (!acct || acct.workspace_id !== ws.id) redirect("/settings/channels");

  let orgs: OrgChoice[] = [];
  try {
    orgs = params.orgs ? (JSON.parse(decodeURIComponent(params.orgs)) as OrgChoice[]) : [];
  } catch {
    orgs = [];
  }

  const creds = acct.credentials as unknown as LinkedInCredentials;

  return (
    <main className="mx-auto max-w-2xl space-y-6 py-8">
      <header className="space-y-2">
        <p className="label-eyebrow">LinkedIn · post target</p>
        <h1 className="text-3xl font-semibold tracking-tight">Where should we post?</h1>
        <p className="text-sm text-muted-foreground">
          You authorized marketingmagic to post on behalf of your personal profile
          {orgs.length === 1
            ? " and one Company Page you administer."
            : ` and ${orgs.length} Company Pages you administer.`}{" "}
          Pick the destination for this connection. You can connect LinkedIn again
          later to add another destination.
        </p>
      </header>

      <form action={selectLinkedInTargetAction} className="space-y-3">
        <input type="hidden" name="account_id" value={acct.id} />

        <label className="flex items-start gap-3 rounded-lg border p-4 hover:bg-muted/30 cursor-pointer">
          <input
            type="radio"
            name="target"
            value="personal"
            defaultChecked
            className="mt-1"
          />
          <div>
            <p className="font-medium">{creds.memberUrn.replace("urn:li:person:", "") || acct.handle}</p>
            <p className="text-xs text-muted-foreground">Personal profile — posts go on your own feed.</p>
          </div>
        </label>

        {orgs.map((org) => (
          <label
            key={org.urn}
            className="flex items-start gap-3 rounded-lg border p-4 hover:bg-muted/30 cursor-pointer"
          >
            <input type="radio" name="target" value={org.urn} className="mt-1" />
            <div>
              <p className="font-medium">{org.name}</p>
              <p className="text-xs text-muted-foreground">
                Company Page — posts go on the {org.name} page feed.
              </p>
            </div>
          </label>
        ))}

        <div className="pt-2">
          <Button type="submit" className="w-full">
            Use this destination
          </Button>
        </div>
      </form>
    </main>
  );
}
