import { Suspense } from "react";
import { XConnectForm } from "./x-connect-form";
import { Button } from "@/components/ui/button";
import { serverEnv } from "@/lib/env";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseService } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

// Inspect existing X social_accounts rows for this workspace and report
// whether they were issued via OAuth or pasted manually. Read via the
// service role since the credentials column is service-only.
async function getXConnectionStatus(workspaceId: string): Promise<{
  connected: boolean;
  handle: string | null;
  isLegacy: boolean; // pasted credentials, no OAuth roundtrip
}> {
  const svc = supabaseService();
  const { data } = await svc
    .from("social_accounts")
    .select("handle, credentials")
    .eq("workspace_id", workspaceId)
    .eq("channel", "x")
    .eq("status", "connected")
    .order("created_at", { ascending: false })
    .limit(1);
  const row = data?.[0];
  if (!row) return { connected: false, handle: null, isLegacy: false };

  // credentials is jsonb of unknown shape — only check for the marker.
  // Anything without an explicit connection_method: "oauth" is treated as
  // legacy (manual paste), which is the safer default for the re-auth nudge.
  const creds = row.credentials as Record<string, unknown> | null;
  const method = creds && typeof creds === "object" ? creds.connection_method : null;
  return {
    connected: true,
    handle: row.handle,
    isLegacy: method !== "oauth",
  };
}

export default async function ConnectXPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  const params = await searchParams;
  const env = serverEnv();
  const ws = await getActiveWorkspaceOrRedirect();
  const status = await getXConnectionStatus(ws.id);
  const oauthConfigured = Boolean(env.X_CLIENT_ID && env.X_CLIENT_SECRET);

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Connect X</h1>
        <p className="text-sm text-muted-foreground">
          One-click connect via Twitter&apos;s 3-legged OAuth flow. We never see
          your password and you can revoke access from your X account settings
          at any time.
        </p>
      </header>

      {params.connected ? (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-4 text-sm">
          <p className="font-medium">Connected @{params.connected}.</p>
          <p className="mt-1 text-muted-foreground">
            Drafts created in /queue can now be posted to this account.
          </p>
        </div>
      ) : null}
      {params.error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="font-medium">Connection failed.</p>
          <p className="mt-1 text-muted-foreground break-words">{params.error}</p>
        </div>
      ) : null}

      {/* Re-auth nudge for users still on manual-paste credentials. We don't
          force them off the old flow — their tokens keep working until X
          rotates them — but OAuth is the recommended path going forward. */}
      {status.connected && status.isLegacy ? (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/5 p-4 text-sm">
          <p className="font-medium">Re-authorize @{status.handle} via OAuth</p>
          <p className="mt-1 text-muted-foreground">
            This account is connected with manually-pasted credentials. Switch
            to OAuth so the tokens refresh automatically when X rotates them
            and so you can revoke access from your X settings.
          </p>
          {oauthConfigured ? (
            <form action="/api/oauth/x/initiate" method="post" className="mt-3">
              <Button type="submit" size="sm">Re-authorize with X</Button>
            </form>
          ) : null}
        </div>
      ) : null}

      {oauthConfigured ? (
        <section className="space-y-3">
          {/* Primary path: hand the user off to Twitter. POSTs to /initiate so
              a stray prefetch can't trigger a token allocation. */}
          <form action="/api/oauth/x/initiate" method="post">
            <Button type="submit" className="w-full">
              {status.connected && !status.isLegacy
                ? `Reconnect @${status.handle}`
                : "Connect with X"}
            </Button>
          </form>
          <p className="text-xs text-muted-foreground">
            You&apos;ll be redirected to X to approve read + write access for
            this workspace.
          </p>
        </section>
      ) : (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/5 p-4 text-sm">
          <p className="font-medium">X OAuth keys are not configured.</p>
          <p className="mt-1 text-muted-foreground">
            Set <code>X_CLIENT_ID</code> and <code>X_CLIENT_SECRET</code> in{" "}
            <code>.env</code>, then restart. Register your app at{" "}
            <a
              className="underline-offset-4 hover:underline"
              href="https://developer.x.com/en/portal/dashboard"
              target="_blank"
              rel="noreferrer"
            >
              developer.x.com
            </a>
            . The manual-paste fallback below still works without OAuth keys.
          </p>
        </div>
      )}

      {/* Legacy manual-paste path. Kept available as a fallback so users
          who have working tokens but can't complete the OAuth flow (private
          app review, IP allowlist, etc.) can still connect. Tagged "legacy"
          in the UI so it doesn't read as the recommended path. */}
      <details className="rounded-md border bg-card">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
          Advanced: paste API keys manually (legacy)
        </summary>
        <div className="space-y-3 border-t px-4 py-4">
          <p className="text-xs text-muted-foreground">
            Generate API keys + access tokens at{" "}
            <a
              href="https://developer.x.com/en/portal/dashboard"
              target="_blank"
              rel="noreferrer"
              className="underline-offset-4 hover:underline"
            >
              developer.x.com
            </a>{" "}
            with the read+write user-context scope. We verify the credentials
            before storing.
          </p>
          <Suspense fallback={null}>
            <XConnectForm />
          </Suspense>
        </div>
      </details>
    </div>
  );
}
