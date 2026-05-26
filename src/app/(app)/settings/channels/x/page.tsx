import { Suspense } from "react";
import { XConnectForm } from "./x-connect-form";
import { Button } from "@/components/ui/button";
import { serverEnv } from "@/lib/env";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseService } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

async function getXConnectionStatus(workspaceId: string): Promise<{
  connected: boolean;
  handle: string | null;
}> {
  const svc = supabaseService();
  const { data } = await svc
    .from("social_accounts")
    .select("handle")
    .eq("workspace_id", workspaceId)
    .eq("channel", "x")
    .eq("status", "connected")
    .order("created_at", { ascending: false })
    .limit(1);
  const row = data?.[0];
  if (!row) return { connected: false, handle: null };
  return { connected: true, handle: row.handle };
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
          One-click connect via X&apos;s OAuth 2.0 flow. We never see your
          password and you can revoke access from your X account settings at
          any time.
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

      {oauthConfigured ? (
        <section className="space-y-3">
          {/* POSTs to /initiate so a stray prefetch can't trigger a token
              allocation. The initiate route generates a PKCE pair, stashes
              the verifier in an httpOnly cookie, and 302s to X. */}
          <form action="/api/oauth/x/initiate" method="post">
            <Button type="submit" className="w-full">
              {status.connected ? `Reconnect @${status.handle}` : "Connect with X"}
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
            Set <code>X_CLIENT_ID</code> and <code>X_CLIENT_SECRET</code> in
            env (use the OAuth 2.0 Client ID/Secret from your X app, not the
            OAuth 1.0a Consumer Keys), then restart. The manual-paste
            fallback below still works without OAuth env vars.
          </p>
        </div>
      )}

      {/* Manual-paste OAuth 1.0a fallback. Useful when (a) PKCE consent
          fails because the X app's User Auth Settings are misconfigured,
          or (b) the user prefers permanent tokens over an OAuth round-trip.
          Generates the credentials manually at developer.x.com → Keys and
          tokens → "Consumer Keys" + "Access Token and Secret". */}
      <details className="rounded-md border bg-card">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
          Advanced: paste API keys manually (OAuth 1.0a fallback)
        </summary>
        <div className="space-y-3 border-t px-4 py-4">
          <p className="text-xs text-muted-foreground">
            Generate the four values at{" "}
            <a
              href="https://developer.x.com/en/portal/dashboard"
              target="_blank"
              rel="noreferrer"
              className="underline-offset-4 hover:underline"
            >
              developer.x.com
            </a>{" "}
            → your app → <strong>Keys and tokens</strong> → <strong>Consumer Keys</strong> (API
            Key + Secret) and <strong>Access Token and Secret</strong>. App
            permissions must be set to <strong>Read and write</strong>. We
            verify the credentials before storing.
          </p>
          <Suspense fallback={null}>
            <XConnectForm />
          </Suspense>
        </div>
      </details>
    </div>
  );
}
