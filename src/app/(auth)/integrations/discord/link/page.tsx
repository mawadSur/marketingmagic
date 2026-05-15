import Link from "next/link";
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { serverEnv } from "@/lib/env";
import { verifyLinkClaimToken } from "@/lib/integrations/sign";

// /integrations/discord/link?token=<signed>
//
// Phase 4.7 — multi-member attribution claim page. The Discord action
// handler hands the actor a signed token after their first un-attributed
// button click; clicking the link here binds (workspace_id, discord_user_id)
// → auth.uid() in discord_links so future approvals attribute correctly.
//
// Token shape: { workspace_id, discord_user_id, discord_username, exp },
// HMAC-signed with EMAIL_LINK_SECRET. 7-day expiry. Re-clicking the same
// link is idempotent — RLS still passes, and the ON CONFLICT swallow below
// means we surface "already linked" cleanly instead of erroring.
//
// Why (auth) group and not (app):
//   The (app) layout redirects un-authed users to /login WITHOUT a `next`
//   param, which would silently strip our signed token. (auth) has no
//   shared layout, so we handle session checking + redirect ourselves and
//   preserve the token through the round-trip.

export const dynamic = "force-dynamic";

interface LinkPageProps {
  searchParams: Promise<{ token?: string }>;
}

export default async function DiscordLinkPage({ searchParams }: LinkPageProps) {
  const { token } = await searchParams;
  const env = serverEnv();

  if (!token) {
    return (
      <Shell title="Missing token.">
        <p>
          This page expects a signed token from a Discord prompt. Open the link from
          the Discord follow-up message.
        </p>
      </Shell>
    );
  }
  if (!env.EMAIL_LINK_SECRET) {
    return (
      <Shell title="Link-claim is not configured.">
        <p>
          The server is missing <code>EMAIL_LINK_SECRET</code>. Ask an admin to
          configure it.
        </p>
      </Shell>
    );
  }

  const verified = verifyLinkClaimToken(token, env.EMAIL_LINK_SECRET);
  if (!verified.ok) {
    const reason =
      verified.reason === "expired"
        ? "This link has expired. Click any approve/reject button in Discord again to get a fresh one."
        : "This link is invalid. It may have been tampered with or copied incompletely.";
    return (
      <Shell title="Link is no longer valid.">
        <p>{reason}</p>
      </Shell>
    );
  }
  const { workspace_id, discord_user_id, discord_username } = verified.payload;

  // Authed-only path. Send unauthed visitors to /login with `next=` so the
  // login form bounces them right back here with the token intact.
  const sb = await supabaseServer();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) {
    const here = `/integrations/discord/link?token=${encodeURIComponent(token)}`;
    redirect(`/login?next=${encodeURIComponent(here)}`);
  }

  // Confirm membership BEFORE attempting the insert — RLS would reject the
  // write anyway, but a tailored message is friendlier than a generic
  // policy violation. is_workspace_member is security definer so it works
  // even when no rows are visible via RLS on the underlying tables.
  const { data: memberCheck } = await sb.rpc("is_workspace_member", {
    ws_id: workspace_id,
  });
  if (!memberCheck) {
    return (
      <Shell title="This link belongs to a different workspace.">
        <p>
          You&rsquo;re signed in as{" "}
          <span className="font-medium text-foreground">
            {user.email ?? user.id}
          </span>
          , but you&rsquo;re not a member of the workspace this Discord prompt came
          from. Ask the workspace owner to invite you, then re-click the Discord
          link.
        </p>
      </Shell>
    );
  }

  // Idempotent insert. The (workspace_id, discord_user_id) PK guarantees at
  // most one binding per (workspace, Discord identity) — re-clicking the
  // same link is a no-op rather than an error. ignoreDuplicates: true makes
  // PostgREST translate the conflict into a clean response.
  const { error: insertErr } = await sb
    .from("discord_links")
    .upsert(
      {
        workspace_id,
        discord_user_id,
        member_user_id: user.id,
      },
      { onConflict: "workspace_id,discord_user_id", ignoreDuplicates: true },
    );
  if (insertErr) {
    // RLS denial or DB error. Surface a friendly message either way; the
    // log captures the actual reason for ops.
    console.log("[discord-link] insert failed:", insertErr.message);
    return (
      <Shell title="Couldn't link your account.">
        <p>
          We hit an error writing the link. Try again in a moment; if it keeps
          failing, ping support with this Discord username:{" "}
          <span className="font-mono">{discord_username}</span>.
        </p>
      </Shell>
    );
  }

  return (
    <main className="container flex min-h-screen items-center justify-center py-16">
      <div className="w-full max-w-md space-y-4">
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-5">
          <h1 className="text-lg font-semibold">You&rsquo;re linked.</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Future Discord approvals will attribute to you (signed in as{" "}
            <span className="font-medium text-foreground">
              {user.email ?? user.id}
            </span>
            ), not the workspace owner.
          </p>
          <p className="mt-3 text-xs text-muted-foreground">
            Linked Discord identity:{" "}
            <span className="font-mono">{discord_username}</span>{" "}
            <span className="text-muted-foreground/70">({discord_user_id})</span>
          </p>
        </div>
        <Link
          href="/dashboard"
          className="inline-block text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          Back to dashboard &rarr;
        </Link>
      </div>
    </main>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="container flex min-h-screen items-center justify-center py-16">
      <div className="w-full max-w-md space-y-4">
        <div className="rounded-md border border-destructive/50 bg-destructive/5 p-5">
          <h1 className="text-lg font-semibold text-destructive">{title}</h1>
          <div className="mt-2 text-sm text-muted-foreground">{children}</div>
        </div>
        <Link
          href="/integrations/discord"
          className="inline-block text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          Discord integration settings &rarr;
        </Link>
      </div>
    </main>
  );
}
