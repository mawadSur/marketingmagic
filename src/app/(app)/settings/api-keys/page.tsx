import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { listApiKeys } from "@/lib/api/manage";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CreateKeyForm, KeyList } from "./key-forms";

export const dynamic = "force-dynamic";

export default async function ApiKeysPage() {
  const ws = await getActiveWorkspaceOrRedirect();
  const svc = await supabaseServer();
  // RLS (is_workspace_member) + the explicit workspace_id filter both scope this
  // to the active workspace. Listing returns metadata only — never the secret.
  const keys = await listApiKeys(svc, ws.id);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">API keys</h1>
        <p className="text-sm text-muted-foreground">
          Call marketingmagic from agents and automation tools (n8n, Make, Zapier, MCP). Keys are
          scoped to this workspace and to the actions you grant.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Create a key</CardTitle>
          <CardDescription>
            Authenticate with <code>Authorization: Bearer &lt;key&gt;</code> against{" "}
            <code>/api/v1</code>. The secret is shown once at creation and never again.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CreateKeyForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your keys</CardTitle>
          <CardDescription>Revoke a key any time — it stops working immediately.</CardDescription>
        </CardHeader>
        <CardContent>
          <KeyList keys={keys} />
        </CardContent>
      </Card>
    </div>
  );
}
