import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import crypto from "node:crypto";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
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

export default function ConnectLinkedInPage() {
  const env = serverEnv();
  const configured = Boolean(env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET);

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Connect LinkedIn</h1>
        <p className="text-sm text-muted-foreground">
          OAuth 2.0 flow via LinkedIn&apos;s &quot;Sign In with LinkedIn using OpenID Connect&quot;
          plus the <code>w_member_social</code> scope. You&apos;ll be redirected to LinkedIn to
          authorize, then back here.
        </p>
      </header>

      {configured ? (
        <form action={startConnect}>
          <Button type="submit">Connect with LinkedIn</Button>
        </form>
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
