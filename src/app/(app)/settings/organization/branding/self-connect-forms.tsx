"use client";

import { useActionState, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  mintSelfConnectAction,
  revokeSelfConnectAction,
  type MintSelfConnectState,
  type RevokeTokenState,
} from "./actions";

// ─── Client self-connect link management ────────────────────────────────
//
// Mirrors PortalLinksManager in branding-forms.tsx one-for-one: one card per
// client workspace, a list of existing self-connect tokens (with expiry /
// revoked state and a two-step revoke), and a mint form. Split into its own file
// so branding-forms.tsx stays under the 500-line cap. The differences from the
// portal links: self-connect tokens have NO scopes (a link can ONLY drive an
// OAuth connect), and the minted link gets an explicit copy button (the raw token
// is shown once at mint time — its hash is all we store).

const mintSelfConnectInitial: MintSelfConnectState = { error: null, rawUrl: null };
const revokeInitial: RevokeTokenState = { error: null };

interface ClientSelfConnectTokens {
  workspaceId: string;
  workspaceName: string;
  tokens: Array<{
    id: string;
    label: string | null;
    expiresAt: string | null;
    revokedAt: string | null;
    createdAt: string;
  }>;
}

export function SelfConnectLinksManager({
  organizationId,
  disabled,
  clients,
}: {
  organizationId: string;
  disabled: boolean;
  clients: ClientSelfConnectTokens[];
}) {
  return (
    <div className="space-y-4">
      {clients.map((c) => (
        <div key={c.workspaceId} className="space-y-3 rounded-lg border bg-card p-5">
          <h3 className="text-sm font-medium">{c.workspaceName}</h3>

          {c.tokens.length > 0 ? (
            <ul className="space-y-2">
              {c.tokens.map((t) => (
                <li
                  key={t.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-background px-3 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{t.label ?? "Untitled link"}</p>
                    <p className="text-xs text-muted-foreground">
                      {t.revokedAt
                        ? "revoked"
                        : t.expiresAt
                          ? `expires ${t.expiresAt.slice(0, 10)}`
                          : "no expiry"}
                    </p>
                  </div>
                  {!t.revokedAt ? (
                    <RevokeSelfConnectButton
                      organizationId={organizationId}
                      workspaceId={c.workspaceId}
                      tokenId={t.id}
                      disabled={disabled}
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground">Revoked</span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            // Cold / empty state — no self-connect link minted for this client yet.
            <p className="text-xs text-muted-foreground">
              No link yet. Generate a link clients use to connect their own channels.
            </p>
          )}

          <MintSelfConnectForm
            organizationId={organizationId}
            workspaceId={c.workspaceId}
            disabled={disabled}
          />
        </div>
      ))}
    </div>
  );
}

function MintSelfConnectForm({
  organizationId,
  workspaceId,
  disabled,
}: {
  organizationId: string;
  workspaceId: string;
  disabled: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    mintSelfConnectAction,
    mintSelfConnectInitial,
  );
  return (
    <form action={formAction} className="space-y-3 rounded-md border bg-muted/20 p-3">
      <input type="hidden" name="organization_id" value={organizationId} />
      <input type="hidden" name="workspace_id" value={workspaceId} />

      <p className="text-xs text-muted-foreground">
        Self-connect currently supports Facebook, Instagram, and Threads (the Meta
        family). Your client signs in with each network directly — their password is
        never shared with you.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1 space-y-1">
          <Label htmlFor={`sc-label-${workspaceId}`} className="text-xs">
            Label (e.g. client contact)
          </Label>
          <Input
            id={`sc-label-${workspaceId}`}
            name="label"
            maxLength={120}
            placeholder="Jane at Client co."
            disabled={disabled}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`sc-exp-${workspaceId}`} className="text-xs">
            Expires (days)
          </Label>
          <Input
            id={`sc-exp-${workspaceId}`}
            name="expires_days"
            type="number"
            min={1}
            max={365}
            placeholder="14"
            className="w-24"
            disabled={disabled}
          />
        </div>
      </div>

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.rawUrl ? <SelfConnectMintedLink rawUrl={state.rawUrl} /> : null}

      <Button type="submit" size="sm" disabled={disabled || pending}>
        {pending ? "Generating…" : "Generate link"}
      </Button>
    </form>
  );
}

// The freshly-minted link + a copy button. Shown once: only the hash is stored,
// so this raw URL can't be recovered later. Copy uses the same navigator
// .clipboard idiom as the team invite form, degrading gracefully (the URL stays
// visible) when the clipboard is blocked.
function SelfConnectMintedLink({ rawUrl }: { rawUrl: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(rawUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (insecure context / permissions); the link is already
      // visible below, so the user can select and copy it manually.
    }
  };
  return (
    <div className="space-y-2 rounded-md border bg-background p-2">
      <p className="text-xs font-medium text-success">
        Link created — copy it now, it won&apos;t be shown again:
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 break-all text-xs">{rawUrl}</code>
        <Button type="button" variant="outline" size="sm" onClick={copy}>
          {copied ? "Copied!" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

// Two-step revoke (click → confirm). Revoking instantly invalidates the link, so
// a client who hasn't connected yet would need a fresh one — a stray click
// shouldn't kill a link mid-send. Mirrors RevokeButton in branding-forms.tsx.
function RevokeSelfConnectButton({
  organizationId,
  workspaceId,
  tokenId,
  disabled,
}: {
  organizationId: string;
  workspaceId: string;
  tokenId: string;
  disabled: boolean;
}) {
  const [state, formAction, pending] = useActionState(revokeSelfConnectAction, revokeInitial);
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <form action={formAction} className="flex flex-col items-end gap-1">
        <input type="hidden" name="organization_id" value={organizationId} />
        <input type="hidden" name="workspace_id" value={workspaceId} />
        <input type="hidden" name="token_id" value={tokenId} />
        <p className="flex items-center gap-1 text-xs text-warning">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
          Turns this link off — the client would need a fresh one to connect.
        </p>
        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={disabled || pending}
            className="rounded-md border border-destructive/30 px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
          >
            {pending ? "Revoking…" : "Yes, revoke"}
          </button>
          <button
            type="button"
            disabled={disabled || pending}
            onClick={() => setConfirming(false)}
            className="rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
        {state.error ? <span className="text-xs text-destructive">{state.error}</span> : null}
      </form>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={disabled || pending}
        onClick={() => setConfirming(true)}
        className="rounded-md border px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
      >
        Revoke
      </button>
      {state.error ? <span className="text-xs text-destructive">{state.error}</span> : null}
    </div>
  );
}
