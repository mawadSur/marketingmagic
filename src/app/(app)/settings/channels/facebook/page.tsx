import { serverEnv } from "@/lib/env";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

// Direct-link target for users who navigate to /settings/channels/facebook
// from elsewhere. The listing-page tile also submits to the same initiate
// route, so this page is mostly a fallback / deep-link surface with extra
// context about scopes and what gets stored.

export default async function ConnectFacebookPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  const params = await searchParams;
  const env = serverEnv();
  const configured = Boolean(env.META_APP_ID && env.META_APP_SECRET);

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Connect Facebook</h1>
        <p className="text-sm text-muted-foreground">
          Publish to a Facebook Page you manage. Scopes:{" "}
          <code>pages_show_list</code>, <code>pages_manage_posts</code>,{" "}
          <code>pages_read_engagement</code>. We store a long-lived Page access token
          server-side and never expose it to the browser.
        </p>
      </header>

      {params.connected ? (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-4 text-sm">
          <p className="font-medium">Connected {params.connected}.</p>
        </div>
      ) : null}
      {params.error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="font-medium">Connection failed.</p>
          <p className="mt-1 text-muted-foreground break-words">{params.error}</p>
        </div>
      ) : null}

      {configured ? (
        <section className="space-y-3">
          <form action="/api/oauth/facebook/initiate" method="post">
            <Button type="submit" className="w-full">
              Connect with Facebook
            </Button>
          </form>
          <p className="text-xs text-muted-foreground">
            You&apos;ll be redirected to Facebook to approve the requested permissions. If
            you manage multiple Pages, we&apos;ll pick the first one with publish access
            &mdash; you can disconnect and reconnect later to switch.
          </p>
        </section>
      ) : (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/5 p-4 text-sm">
          <p className="font-medium">Meta OAuth keys are not configured.</p>
          <p className="mt-1 text-muted-foreground">
            Set <code>META_APP_ID</code> and <code>META_APP_SECRET</code> in <code>.env</code>{" "}
            and add the Facebook Login + Manage Pages products to your Meta app at{" "}
            <a
              className="underline-offset-4 hover:underline"
              href="https://developers.facebook.com/apps/"
              target="_blank"
              rel="noreferrer"
            >
              developers.facebook.com/apps
            </a>
            .
          </p>
        </div>
      )}
    </div>
  );
}
