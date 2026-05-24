import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import crypto from "node:crypto";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { serverEnv, siteUrl } from "@/lib/env";
import { instagramAuthorizeUrl } from "@/lib/social/instagram";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

async function startConnect() {
  "use server";
  const env = serverEnv();
  if (!env.INSTAGRAM_APP_ID || !env.INSTAGRAM_APP_SECRET) {
    redirect("/settings/channels?error=instagram_not_configured");
  }
  const ws = await getActiveWorkspaceOrRedirect();
  const nonce = crypto.randomBytes(16).toString("hex");
  const state = `${ws.id}:${nonce}`;
  const redirectUri = `${siteUrl()}/api/oauth/instagram/callback`;
  const url = instagramAuthorizeUrl({ redirectUri, state });
  const jar = await cookies();
  jar.set("ig_oauth_nonce", nonce, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 10 * 60,
    path: "/",
  });
  redirect(url);
}

export default function ConnectInstagramPage() {
  const env = serverEnv();
  const configured = Boolean(env.INSTAGRAM_APP_ID && env.INSTAGRAM_APP_SECRET);
  return (
    <div className="mx-auto max-w-xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Connect Instagram</h1>
        <p className="text-sm text-muted-foreground">
          Requires an Instagram Business or Creator account. You authorize directly with
          Instagram &mdash; no Facebook Page connection needed.
        </p>
      </header>
      {configured ? (
        <form action={startConnect}>
          <Button type="submit">Connect with Instagram</Button>
        </form>
      ) : (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/5 p-4 text-sm">
          <p className="font-medium">Instagram OAuth keys are not configured.</p>
          <p className="mt-1 text-muted-foreground">
            Set <code>INSTAGRAM_APP_ID</code> and <code>INSTAGRAM_APP_SECRET</code> in <code>.env</code>.
          </p>
        </div>
      )}
    </div>
  );
}
