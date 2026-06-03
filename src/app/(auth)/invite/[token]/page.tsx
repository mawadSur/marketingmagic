import Link from "next/link";
import { redirect } from "next/navigation";
import { serverEnv } from "@/lib/env";
import { supabaseService } from "@/lib/supabase/service";
import { supabaseServer } from "@/lib/supabase/server";
import { verifyInvitationToken } from "@/lib/memberships/invitations";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/ui/logo";
import { acceptInvitationAction, declineInvitationAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Public invitation acceptance page.
 *
 * Flow:
 *   * Unauth visitor → render the workspace name + role + a "Sign up to
 *     accept" CTA that preserves the token through signup.
 *   * Authed visitor → render an "Accept" / "Decline" pair of buttons.
 *
 * Error states surface via `?error=` query (set by the action redirects).
 * We never throw on this page — bad token / expired / already used all
 * render a graceful explainer.
 */
export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const sp = await searchParams;
  const env = serverEnv();

  if (!env.EMAIL_LINK_SECRET) {
    return (
      <Shell title="Invitations are not configured">
        <p>
          This deployment doesn&apos;t have email-link signing configured. Ask the
          workspace owner to invite you directly once <code>EMAIL_LINK_SECRET</code>{" "}
          is set.
        </p>
      </Shell>
    );
  }

  const verified = verifyInvitationToken(token, env.EMAIL_LINK_SECRET);
  if (!verified.ok) {
    return (
      <Shell title="Invitation link isn't valid">
        <p>
          This invitation link is{" "}
          {verified.reason === "expired" ? "expired" : "no longer valid"}. Ask the
          workspace owner to send a fresh one.
        </p>
        <Link
          href="/login"
          className="text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          Go to login
        </Link>
      </Shell>
    );
  }

  const svc = supabaseService();
  const { data: inv } = await svc
    .from("workspace_invitations")
    .select("id, workspace_id, email, role, accepted_at, expires_at")
    .eq("token", token)
    .maybeSingle();

  if (!inv) {
    return (
      <Shell title="Invitation not found">
        <p>
          We can&apos;t find this invitation. It may have been revoked. Ask the
          workspace owner to send a fresh one.
        </p>
      </Shell>
    );
  }
  if (inv.accepted_at) {
    return (
      <Shell title="Invitation already used">
        <p>
          This invitation link has already been used. If that wasn&apos;t you, ask
          the workspace owner to investigate.
        </p>
        <Link href="/login" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
          Go to login
        </Link>
      </Shell>
    );
  }
  if (new Date(inv.expires_at) < new Date()) {
    return (
      <Shell title="Invitation expired">
        <p>
          This invitation has expired. Ask the workspace owner to send a fresh one.
        </p>
      </Shell>
    );
  }

  const { data: ws } = await svc
    .from("workspaces")
    .select("name")
    .eq("id", inv.workspace_id)
    .maybeSingle();
  const workspaceName = ws?.name ?? "a workspace";

  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // If they're authed AND match the invited email, present a single
  // confirm button. If they're authed under a different email, give
  // them an out: log out and try again under the right account.
  const isAuthed = Boolean(user);
  const emailMatches = isAuthed && user?.email?.toLowerCase() === inv.email.toLowerCase();

  const errorBanner = sp.error ? <ErrorBanner reason={sp.error} /> : null;

  return (
    <Shell title={`Join ${workspaceName}`}>
      <p>
        You&apos;ve been invited to collaborate on{" "}
        <strong className="text-foreground">{workspaceName}</strong> as{" "}
        <strong className="text-foreground">{inv.role}</strong>.
      </p>
      <p className="text-sm text-muted-foreground">
        Invitation for <span className="font-mono">{inv.email}</span>.
      </p>
      {errorBanner}

      {!isAuthed ? (
        <div className="space-y-3">
          <Link
            href={`/signup?invite=${encodeURIComponent(token)}&email=${encodeURIComponent(inv.email)}`}
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Sign up to accept
          </Link>
          <p className="text-xs text-muted-foreground">
            Already have an account?{" "}
            <Link
              href={`/login?invite=${encodeURIComponent(token)}&email=${encodeURIComponent(inv.email)}`}
              className="text-primary underline-offset-4 hover:underline"
            >
              Log in
            </Link>
          </p>
        </div>
      ) : emailMatches ? (
        <div className="flex flex-wrap gap-2">
          <form action={acceptInvitationAction}>
            <input type="hidden" name="token" value={token} />
            <Button type="submit">Accept invitation</Button>
          </form>
          <form action={declineInvitationAction}>
            <input type="hidden" name="token" value={token} />
            <Button type="submit" variant="outline">
              Decline
            </Button>
          </form>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
            You&apos;re logged in as{" "}
            <span className="font-mono">{user?.email}</span>, but this invite was
            sent to <span className="font-mono">{inv.email}</span>.
          </p>
          <div className="flex flex-wrap gap-2">
            <form action={acceptInvitationAction}>
              <input type="hidden" name="token" value={token} />
              <Button type="submit">Accept anyway</Button>
            </form>
            <form action="/auth/logout" method="post">
              <Button type="submit" variant="outline">
                Log out and switch
              </Button>
            </form>
          </div>
        </div>
      )}
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="container flex min-h-screen items-center justify-center py-16">
      <div className="w-full max-w-md space-y-6">
        <div className="space-y-3 text-center">
          <Link
            href="/"
            className="mx-auto inline-flex rounded-lg transition-opacity duration-200 hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            aria-label="marketingmagic home"
          >
            <Logo variant="full" size="lg" />
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        </div>
        <div className="space-y-4 rounded-lg border bg-card p-6 text-sm text-muted-foreground shadow-sm">
          {children}
        </div>
      </div>
    </main>
  );
}

function ErrorBanner({ reason }: { reason: string }) {
  const message =
    reason === "expired"
      ? "This invitation has expired."
      : reason === "already_used"
        ? "This invitation has already been used."
        : reason === "missing"
          ? "We couldn't find this invitation. It may have been revoked."
          : reason === "insert_failed"
            ? "Couldn't add you to the workspace. Try again or ask the owner."
            : reason === "disabled"
              ? "Invitations aren't configured on this deployment."
              : "Something went wrong. Try again.";
  return (
    <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
      {message}
    </p>
  );
}
