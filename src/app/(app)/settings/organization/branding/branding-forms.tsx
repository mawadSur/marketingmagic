"use client";

import Image from "next/image";
import { useActionState, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  updateBrandingAction,
  mintTokenAction,
  revokeTokenAction,
  emailInviteAction,
  type BrandingState,
  type MintTokenState,
  type RevokeTokenState,
  type EmailInviteState,
} from "./actions";
import type { ClientPortalScope } from "@/lib/db/types";

const brandingInitial: BrandingState = { error: null, ok: false };
const mintInitial: MintTokenState = { error: null, rawUrl: null };
const revokeInitial: RevokeTokenState = { error: null };
const emailInviteInitial: EmailInviteState = { error: null, status: null };

export function BrandingForm({
  organizationId,
  disabled,
  initial,
}: {
  organizationId: string;
  disabled: boolean;
  initial: { logoUrl: string | null; colorPrimary: string | null; colorAccent: string | null };
}) {
  const [state, formAction, pending] = useActionState(updateBrandingAction, brandingInitial);
  const [primary, setPrimary] = useState(initial.colorPrimary ?? "#0a0a0a");
  const [accent, setAccent] = useState(initial.colorAccent ?? "#2563eb");

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="organization_id" value={organizationId} />

      <div className="space-y-2">
        <Label htmlFor="logo">Logo</Label>
        {initial.logoUrl ? (
          <Image
            src={initial.logoUrl}
            alt="Current logo"
            width={48}
            height={48}
            className="h-12 w-12 rounded-md border object-contain"
            unoptimized
          />
        ) : (
          <p className="text-xs text-muted-foreground">No logo set yet.</p>
        )}
        <Input
          id="logo"
          name="logo"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
          disabled={disabled}
        />
        <p className="text-xs text-muted-foreground">PNG, JPEG, WebP, or SVG. Max 2MB.</p>
      </div>

      <div className="flex flex-wrap gap-6">
        <ColorField
          id="color_primary"
          label="Primary color"
          value={primary}
          onChange={setPrimary}
          disabled={disabled}
        />
        <ColorField
          id="color_accent"
          label="Accent color"
          value={accent}
          onChange={setAccent}
          disabled={disabled}
        />
      </div>

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.ok ? <p className="text-sm text-success">Branding saved.</p> : null}

      <Button type="submit" disabled={disabled || pending}>
        {pending ? "Saving…" : "Save branding"}
      </Button>
    </form>
  );
}

function ColorField({
  id,
  label,
  value,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="h-9 w-12 cursor-pointer rounded border bg-background"
          aria-label={`${label} picker`}
        />
        <Input
          id={id}
          name={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="w-28 font-mono text-sm"
          maxLength={7}
        />
      </div>
    </div>
  );
}

// ─── Portal link management ─────────────────────────────────────────────

interface ClientTokens {
  workspaceId: string;
  workspaceName: string;
  tokens: Array<{
    id: string;
    label: string | null;
    scopes: ClientPortalScope[];
    expiresAt: string | null;
    revokedAt: string | null;
    createdAt: string;
  }>;
}

export function PortalLinksManager({
  organizationId,
  disabled,
  clients,
}: {
  organizationId: string;
  disabled: boolean;
  clients: ClientTokens[];
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
                      {t.scopes.join(", ") || "no scopes"} ·{" "}
                      {t.revokedAt
                        ? "revoked"
                        : t.expiresAt
                          ? `expires ${t.expiresAt.slice(0, 10)}`
                          : "no expiry"}
                    </p>
                  </div>
                  {!t.revokedAt ? (
                    <RevokeButton
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
            <p className="text-xs text-muted-foreground">No links yet.</p>
          )}

          <MintLinkForm
            organizationId={organizationId}
            workspaceId={c.workspaceId}
            disabled={disabled}
          />
        </div>
      ))}
    </div>
  );
}

function MintLinkForm({
  organizationId,
  workspaceId,
  disabled,
}: {
  organizationId: string;
  workspaceId: string;
  disabled: boolean;
}) {
  const [state, formAction, pending] = useActionState(mintTokenAction, mintInitial);
  return (
    <form action={formAction} className="space-y-3 rounded-md border bg-muted/20 p-3">
      <input type="hidden" name="organization_id" value={organizationId} />
      <input type="hidden" name="workspace_id" value={workspaceId} />

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1 space-y-1">
          <Label htmlFor={`label-${workspaceId}`} className="text-xs">
            Label (e.g. client contact)
          </Label>
          <Input
            id={`label-${workspaceId}`}
            name="label"
            maxLength={120}
            placeholder="Jane at Client co."
            disabled={disabled}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`exp-${workspaceId}`} className="text-xs">
            Expires (days)
          </Label>
          <Input
            id={`exp-${workspaceId}`}
            name="expires_days"
            type="number"
            min={1}
            max={365}
            placeholder="30"
            className="w-24"
            disabled={disabled}
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" name="scope_approve" value="1" defaultChecked disabled={disabled} />
          Approve drafts
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="scope_view_reports"
            value="1"
            defaultChecked
            disabled={disabled}
          />
          View reports
        </label>
      </div>

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.rawUrl ? (
        <div className="space-y-2 rounded-md border bg-background p-2">
          <div className="space-y-1">
            <p className="text-xs font-medium text-success">
              Link created — copy it now, it won&apos;t be shown again:
            </p>
            <code className="block break-all text-xs">{state.rawUrl}</code>
          </div>
          <EmailInviteForm
            organizationId={organizationId}
            portalUrl={state.rawUrl}
            disabled={disabled}
          />
        </div>
      ) : null}

      <Button type="submit" size="sm" disabled={disabled || pending}>
        {pending ? "Creating…" : "Create link"}
      </Button>
    </form>
  );
}

// Email the freshly-minted share link to a client contact. Lives inline under
// the minted-link block because the raw link is only available at mint time
// (only its hash is stored). Org-admin gated server-side; degrades to a clear
// "email not configured" notice when RESEND_API_KEY is unset (status
// "skipped"). The link is always copyable above regardless of email config.
function EmailInviteForm({
  organizationId,
  portalUrl,
  disabled,
}: {
  organizationId: string;
  portalUrl: string;
  disabled: boolean;
}) {
  const [state, formAction, pending] = useActionState(emailInviteAction, emailInviteInitial);
  return (
    <form action={formAction} className="space-y-2 border-t pt-2">
      <input type="hidden" name="organization_id" value={organizationId} />
      <input type="hidden" name="portal_url" value={portalUrl} />
      <Label htmlFor={`invite-${organizationId}`} className="text-xs">
        Email this link to the client
      </Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={`invite-${organizationId}`}
          name="recipient"
          type="email"
          placeholder="jane@client.co"
          className="h-8 flex-1 text-sm"
          disabled={disabled}
          required
        />
        <Button type="submit" size="sm" variant="outline" disabled={disabled || pending}>
          {pending ? "Sending…" : "Send"}
        </Button>
      </div>
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
      {state.status === "sent" ? (
        <p className="text-xs text-success">Sent. The client now has their link.</p>
      ) : null}
      {state.status === "skipped" ? (
        <p className="text-xs text-warning">
          Email isn&apos;t configured on this deployment, so nothing was sent —
          copy the link above and share it manually.
        </p>
      ) : null}
    </form>
  );
}

// Two-step revoke (click → confirm) because revoking a link instantly cuts off
// any live client-portal sessions using it — a stray click shouldn't lock a
// client out mid-session.
function RevokeButton({
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
  const [state, formAction, pending] = useActionState(revokeTokenAction, revokeInitial);
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <form action={formAction} className="flex flex-col items-end gap-1">
        <input type="hidden" name="organization_id" value={organizationId} />
        <input type="hidden" name="workspace_id" value={workspaceId} />
        <input type="hidden" name="token_id" value={tokenId} />
        <p className="flex items-center gap-1 text-xs text-warning">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
          Instantly disconnects any live client-portal sessions on this link.
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
