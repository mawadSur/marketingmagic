import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import crypto from "node:crypto";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { serverEnv, siteUrl } from "@/lib/env";
import { linkedinAuthorizeUrl } from "@/lib/social/linkedin";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

async function startConnect() {
  "use server";
  const env = serverEnv();
  if (!env.LINKEDIN_CLIENT_ID || !env.LINKEDIN_CLIENT_SECRET) {
    redirect("/settings/channels?error=linkedin_not_configured");
  }
  const ws = await getActiveWorkspaceOrRedirect();
  const nonce = crypto.randomBytes(16).toString("hex");
  const state = `${ws.id}:${nonce}`;
  const redirectUri = `${siteUrl()}/api/oauth/linkedin/callback`;
  const url = linkedinAuthorizeUrl({ redirectUri, state });
  const jar = await cookies();
  jar.set("li_oauth_nonce", nonce, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 10 * 60,
    path: "/",
  });
  redirect(url);
}

export default async function ConnectLinkedInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const env = serverEnv();
  const configured = Boolean(env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET);

  // Existing connections so we can prompt the user to manage instead of
  // re-connect when one already exists on this workspace.
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();
  const { data: existing } = await supabase
    .from("social_accounts_safe")
    .select("id, handle, status")
    .eq("workspace_id", ws.id)
    .eq("channel", "linkedin")
    .order("created_at", { ascending: false });

  const connected = existing ?? [];

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <header className="space-y-1">
        <p className="label-eyebrow">Settings · Channels</p>
        <h1 className="text-2xl font-semibold tracking-tight">Connect LinkedIn</h1>
        <p className="text-sm text-muted-foreground">
          OAuth 2.0 (Sign In with LinkedIn using OpenID Connect) plus the{" "}
          <code>w_member_social</code> and Community Management{" "}
          (<code>w_organization_social</code>) scopes so we can publish to your
          personal profile <em>and</em> any Company Pages you administer. We
          never store your LinkedIn password — tokens live server-side and are
          never exposed to the browser.
        </p>
      </header>

      {error ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/5 p-4 text-sm">
          <p className="font-medium text-destructive">Connection failed.</p>
          <p className="mt-1 text-muted-foreground">{decodeURIComponent(error)}</p>
        </div>
      ) : null}

      {connected.length > 0 ? (
        <div className="space-y-2 rounded-md border bg-card p-4">
          <p className="text-sm font-medium">Already connected</p>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {connected.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3">
                <span>@{c.handle}</span>
                <Link
                  href={`/settings/channels/${c.id}`}
                  className="text-xs underline-offset-4 hover:underline"
                >
                  manage →
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {configured ? (
        <div className="space-y-3">
          <form action={startConnect}>
            <Button type="submit">
              {connected.length > 0 ? "Connect another LinkedIn account" : "Connect with LinkedIn"}
            </Button>
          </form>
          <p className="text-xs text-muted-foreground">
            What we&apos;ll access: your name, email, and the ability to publish
            to your personal profile and any Company Pages you administer. After
            you authorize, we&apos;ll ask which destination this connection
            should post to.
          </p>
        </div>
      ) : (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/5 p-4 text-sm">
          <p className="font-medium">LinkedIn OAuth keys are not configured.</p>
          <p className="mt-1 text-muted-foreground">
            Set <code>LINKEDIN_CLIENT_ID</code> and <code>LINKEDIN_CLIENT_SECRET</code> in{" "}
            <code>.env</code>, then restart. Register your app at{" "}
            <a
              className="underline-offset-4 hover:underline"
              href="https://www.linkedin.com/developers/apps"
              target="_blank"
              rel="noreferrer"
            >
              linkedin.com/developers/apps
            </a>
            .
          </p>
        </div>
      )}
    </div>
  );
}
