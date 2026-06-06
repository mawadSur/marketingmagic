import Image from "next/image";
import { ChannelBadge } from "@/components/ui/badge";
import { resolveSelfConnectToken } from "@/lib/client-connect/token";
import { getSelfConnectBranding, getConnectedChannels } from "@/lib/client-connect/data";
import {
  configuredSelfConnectChannels,
  channelLabel,
  type SelfConnectChannel,
} from "@/lib/client-connect/initiate";
import { resolveTheme } from "@/lib/portal/branding";

export const dynamic = "force-dynamic";

// /connect/[token] — the unauthenticated client self-connect landing page.
//
// The agency emails this link to a client so the CLIENT connects their OWN
// social accounts (no credential handoff). It resolves the raw token to a
// validated context (workspace), then shows one tile per supported+configured
// channel. Each tile POSTs to the tokenized initiate route, which reuses the
// EXISTING per-channel OAuth flow and attributes the connection to this client
// workspace. An invalid/expired/revoked token renders a single generic page —
// we never reveal which condition failed nor anything about the workspace.
export default async function ClientSelfConnectPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  const { token } = await params;
  const sp = await searchParams;
  const ctx = await resolveSelfConnectToken(token);

  if (!ctx) {
    return <InvalidLink />;
  }

  const [branding, connected] = await Promise.all([
    getSelfConnectBranding(ctx),
    getConnectedChannels(ctx),
  ]);
  const theme = resolveTheme(branding);
  const available = configuredSelfConnectChannels();

  return (
    <main className="mx-auto max-w-xl px-4 py-10">
      <header
        className="mb-8 flex items-center gap-4 border-b pb-6"
        style={{ borderColor: theme.accent }}
      >
        {theme.logoUrl ? (
          <Image
            src={theme.logoUrl}
            alt={theme.brandName}
            width={48}
            height={48}
            className="h-12 w-12 rounded-md object-contain"
            unoptimized
          />
        ) : (
          <div
            className="flex h-12 w-12 items-center justify-center rounded-md text-lg font-semibold text-white"
            style={{ backgroundColor: theme.accent }}
          >
            {theme.brandName.slice(0, 1).toUpperCase()}
          </div>
        )}
        <div>
          <h1 className="text-xl font-semibold tracking-tight" style={{ color: theme.primary }}>
            {theme.brandName}
          </h1>
          <p className="text-sm text-muted-foreground">
            {branding.workspaceName} · Connect your accounts
          </p>
        </div>
      </header>

      <p className="mb-6 text-sm text-muted-foreground">
        Connect your social accounts so {theme.brandName} can publish on your behalf. You
        sign in directly with each network — your password is never shared with the agency.
      </p>

      {sp.connected ? (
        <div className="mb-6 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-4 text-sm">
          <p className="font-medium capitalize">{sp.connected} connected. Thank you!</p>
        </div>
      ) : null}
      {sp.error ? (
        <div className="mb-6 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="font-medium">That connection didn&apos;t go through.</p>
          <p className="mt-1 text-muted-foreground break-words">{sp.error}</p>
        </div>
      ) : null}

      {available.length === 0 ? (
        <p className="rounded-lg border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
          No networks are available to connect right now. Your account manager has been
          notified — please check back shortly.
        </p>
      ) : (
        <div className="grid gap-2">
          {available.map((channel: SelfConnectChannel) => {
            const isConnected = connected.has(channel);
            return isConnected ? (
              <span
                key={channel}
                className="flex items-center gap-3 rounded-md border bg-card px-3 py-2.5 text-sm font-medium opacity-70"
              >
                <ChannelBadge channel={channel} />
                <span>{channelLabel(channel)}</span>
                <span className="ml-auto text-xs font-medium text-emerald-600">✓ Connected</span>
              </span>
            ) : (
              <form
                key={channel}
                action={`/api/client-connect/${encodeURIComponent(token)}/${channel}/initiate`}
                method="post"
              >
                <button
                  type="submit"
                  className="card-hover flex w-full items-center gap-3 rounded-md border bg-card px-3 py-2.5 text-left text-sm font-medium"
                >
                  <ChannelBadge channel={channel} />
                  <span>Connect {channelLabel(channel)}</span>
                  <span aria-hidden className="ml-auto text-muted-foreground">
                    →
                  </span>
                </button>
              </form>
            );
          })}
        </div>
      )}

      <p className="mt-8 text-center text-xs text-muted-foreground">
        Powered by {theme.brandName}. This is a private link — please don&apos;t forward it.
      </p>
    </main>
  );
}

function InvalidLink() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-4 text-center">
      <h1 className="text-lg font-semibold">This link isn&apos;t valid</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        It may have expired or been turned off. Ask your account manager for a fresh link.
      </p>
    </main>
  );
}
