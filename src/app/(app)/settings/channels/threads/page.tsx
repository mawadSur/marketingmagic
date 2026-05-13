import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import crypto from "node:crypto";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { serverEnv, siteUrl } from "@/lib/env";
import { threadsAuthorizeUrl } from "@/lib/social/threads";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

async function startConnect() {
  "use server";
  const env = serverEnv();
  if (!env.META_APP_ID || !env.META_APP_SECRET) {
    redirect("/settings/channels?error=threads_not_configured");
  }
  const ws = await getActiveWorkspaceOrRedirect();
  const nonce = crypto.randomBytes(16).toString("hex");
  const state = `${ws.id}:${nonce}`;
  const redirectUri = `${siteUrl()}/api/oauth/threads/callback`;
  const url = threadsAuthorizeUrl({ redirectUri, state });
  const jar = await cookies();
  jar.set("th_oauth_nonce", nonce, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 10 * 60,
    path: "/",
  });
  redirect(url);
}

export default function ConnectThreadsPage() {
  const env = serverEnv();
  const configured = Boolean(env.META_APP_ID && env.META_APP_SECRET);
  return (
    <div className="mx-auto max-w-xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Connect Threads</h1>
        <p className="text-sm text-muted-foreground">
          OAuth flow via Meta. Scopes: <code>threads_basic</code>, <code>threads_content_publish</code>, <code>threads_manage_insights</code>.
        </p>
      </header>
      {configured ? (
        <form action={startConnect}>
          <Button type="submit">Connect with Threads</Button>
        </form>
      ) : (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/5 p-4 text-sm">
          <p className="font-medium">Meta OAuth keys are not configured.</p>
          <p className="mt-1 text-muted-foreground">
            Set <code>META_APP_ID</code> and <code>META_APP_SECRET</code> in <code>.env</code> and
            register your app at{" "}
            <a className="underline-offset-4 hover:underline" href="https://developers.facebook.com/apps/" target="_blank" rel="noreferrer">
              developers.facebook.com/apps
            </a>
            .
          </p>
        </div>
      )}
    </div>
  );
}
