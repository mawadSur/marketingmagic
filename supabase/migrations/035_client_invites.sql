-- marketingmagic · 035 — Client portal invite audit trail
--
-- Completes the "email the share link to the client" slice of the agency/org
-- layer (Phase D/E). A client's portal/report link is minted in
-- migration 029 (client_portal_tokens) and surfaced in
-- /settings/organization/branding. Until now the link was copied + pasted into
-- the agency's own email client by hand. The new "Email this link to the
-- client" action sends a branded transactional email via Resend; this table
-- records each send so an org admin has an audit trail of WHO was emailed WHICH
-- token and WHEN.
--
-- This is purely an audit log — it never gates portal access (the token alone
-- does that, validated by the hardened service-role DAL). Sending is also fully
-- functional WITHOUT this table; the row insert is best-effort and the email
-- itself degrades to a log-and-skip when RESEND_API_KEY is unset.
--
-- RLS is ORG-SCOPED via the existing is_workspace_member(workspace_id) helper
-- (extended in 029 to include org staff), so an org member can only ever read
-- invite rows for client workspaces in THEIR org. No cross-org leakage.

create table public.client_invites (
  id uuid primary key default gen_random_uuid(),
  -- The client workspace whose portal link was emailed. CASCADE so deleting a
  -- client workspace cleans up its invite history.
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- The portal token that was shared. SET NULL on token delete so the audit row
  -- survives a token revocation/cleanup (we still want "Jane was emailed on X").
  token_id uuid references public.client_portal_tokens(id) on delete set null,
  -- Recipient + who sent it (the agency staff member). created_by SET NULL on
  -- user delete keeps the historical record.
  recipient_email text not null,
  created_by uuid references auth.users(id) on delete set null,
  sent_at timestamptz not null default now()
);

create index client_invites_workspace_idx
  on public.client_invites(workspace_id);

create index client_invites_token_idx
  on public.client_invites(token_id)
  where token_id is not null;

alter table public.client_invites enable row level security;

-- Members of the workspace (which, via the 029-extended is_workspace_member,
-- includes org staff of the workspace's organization) can read the invite
-- history. Strictly org-scoped → no cross-org leakage.
create policy "Members read client invites"
  on public.client_invites for select
  using (public.is_workspace_member(workspace_id));

-- Inserts come from the server action AFTER an org-admin authz check, written
-- with the authed (RLS-backed) client; the WITH CHECK keeps an insert scoped to
-- a workspace the caller can already see and pins created_by to the caller.
create policy "Members insert client invites"
  on public.client_invites for insert
  to authenticated
  with check (
    public.is_workspace_member(workspace_id)
    and (created_by is null or created_by = auth.uid())
  );
