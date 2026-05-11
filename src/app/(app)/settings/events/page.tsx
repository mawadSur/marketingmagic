import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { EventRulesEditor } from "./event-rules-editor";
import { WebhookCard } from "./webhook-card";
import { serverEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function EventsPage() {
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();
  const svc = supabaseService();

  // Fetch with service client because workspaces.webhook_secret is sensitive
  // and the rendering happens server-side only.
  const [secretRes, rulesRes] = await Promise.all([
    svc.from("workspaces").select("webhook_secret").eq("id", ws.id).maybeSingle(),
    supabase
      .from("event_rules")
      .select("*")
      .eq("workspace_id", ws.id)
      .order("created_at", { ascending: true }),
  ]);

  const base = serverEnv().NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
  const url = `${base}/api/webhooks/${ws.id}`;

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Event ingestion</h1>
        <p className="text-sm text-muted-foreground">
          External systems (your product) POST signed events here. Rules render templates into post
          drafts.
        </p>
      </header>

      <WebhookCard url={url} secret={secretRes.data?.webhook_secret ?? ""} />
      <EventRulesEditor rules={rulesRes.data ?? []} />
    </div>
  );
}
