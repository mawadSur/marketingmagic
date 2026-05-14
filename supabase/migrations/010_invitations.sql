-- marketingmagic · 010 — Workspace invitations + memberships management
--
-- Phase 4 (Self-Serve Growth): unblock the team-invite flow. Owners need a
-- way to send a magic-link invitation that adds a recipient as a workspace
-- member when accepted. Two concerns ship together because they share the
-- same trust boundary (workspace ownership):
--
--   1. workspace_invitations — pending invitations awaiting acceptance.
--      Token is signed HMAC (EMAIL_LINK_SECRET) and stored here too so
--      we can audit / revoke / list pending invites. The token alone is
--      enough to accept, but cross-checking against the table lets us:
--        - revoke an outstanding invite before it's accepted
--        - mark accepted_at so a link can't be reused
--        - show pending invitations in the team UI
--
--   2. memberships INSERT/DELETE/UPDATE policies — the original 001 schema
--      only gave memberships a SELECT policy (multi-user was unused in V0).
--      Now that the team UI mutates this table, owners need permissive
--      policies to add and remove members. Service-role still owns the
--      invitation-acceptance path (because the accepting user must be able
--      to insert their own membership row, and they aren't an owner yet).
--
-- Hard rule: only OWNERS invite / remove / change roles. Editors and viewers
-- get read-only visibility into the team list (via memberships SELECT).
--
-- ── ENV NOTE (because .env.local.example is permission-blocked in this
--    worktree, the operator must add this block manually if missing) ────
--
--   # ─── Team invitations (Phase 4) ───
--   # RESEND_API_KEY     — already documented for email-digest; reused here.
--   # EMAIL_LINK_SECRET  — already documented for email-digest; reused here.
--   # EMAIL_FROM         — already documented for email-digest; reused here.
--   # No new env vars are required. If RESEND_API_KEY is unset the invite
--   # flow falls back to displaying the magic link in the UI for the owner
--   # to send manually.
--
-- ──────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────
-- workspace_invitations
-- ─────────────────────────────────────────────────────────────
create table if not exists public.workspace_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email text not null,
  -- Only editor/viewer can be invited. Owner is set once at workspace creation
  -- and ownership transfer is a separate flow.
  role text not null check (role in ('editor', 'viewer')),
  invited_by uuid not null references auth.users(id) on delete restrict,
  -- HMAC-signed token. Stored verbatim so we can revoke by setting accepted_at
  -- without the recipient knowing. Unique so a leaked token can't be reused.
  token text not null unique,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists workspace_invitations_token_idx
  on public.workspace_invitations(token);

create index if not exists workspace_invitations_pending_idx
  on public.workspace_invitations(workspace_id, accepted_at)
  where accepted_at is null;

create index if not exists workspace_invitations_email_idx
  on public.workspace_invitations(lower(email));

alter table public.workspace_invitations enable row level security;

-- Only owners can see or mutate invitations for their workspaces. Editors
-- and viewers explicitly do NOT see pending invites — invites are an
-- owner-only artefact.
create policy "Owners read workspace_invitations"
  on public.workspace_invitations for select
  using (
    exists (
      select 1 from public.workspaces w
      where w.id = workspace_id and w.owner_id = auth.uid()
    )
  );

create policy "Owners insert workspace_invitations"
  on public.workspace_invitations for insert
  to authenticated
  with check (
    exists (
      select 1 from public.workspaces w
      where w.id = workspace_id and w.owner_id = auth.uid()
    )
    and invited_by = auth.uid()
  );

create policy "Owners update workspace_invitations"
  on public.workspace_invitations for update
  using (
    exists (
      select 1 from public.workspaces w
      where w.id = workspace_id and w.owner_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.workspaces w
      where w.id = workspace_id and w.owner_id = auth.uid()
    )
  );

create policy "Owners delete workspace_invitations"
  on public.workspace_invitations for delete
  using (
    exists (
      select 1 from public.workspaces w
      where w.id = workspace_id and w.owner_id = auth.uid()
    )
  );

-- ─────────────────────────────────────────────────────────────
-- memberships — round out the original SELECT-only policy set
-- ─────────────────────────────────────────────────────────────
-- 001_init.sql added one policy: users can read their own membership rows.
-- The team UI also needs:
--   * owners to read every membership in their workspaces (to render the team list)
--   * owners to insert / delete / update memberships in their workspaces
-- Acceptance of an invitation by a non-owner uses service-role; no public
-- INSERT policy is added for the invitee path (they aren't an owner yet).

create policy "Owners read workspace memberships"
  on public.memberships for select
  using (
    exists (
      select 1 from public.workspaces w
      where w.id = workspace_id and w.owner_id = auth.uid()
    )
  );

create policy "Owners insert memberships"
  on public.memberships for insert
  to authenticated
  with check (
    exists (
      select 1 from public.workspaces w
      where w.id = workspace_id and w.owner_id = auth.uid()
    )
  );

create policy "Owners update memberships"
  on public.memberships for update
  using (
    exists (
      select 1 from public.workspaces w
      where w.id = workspace_id and w.owner_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.workspaces w
      where w.id = workspace_id and w.owner_id = auth.uid()
    )
  );

create policy "Owners delete memberships"
  on public.memberships for delete
  using (
    exists (
      select 1 from public.workspaces w
      where w.id = workspace_id and w.owner_id = auth.uid()
    )
  );

-- ─────────────────────────────────────────────────────────────
-- workspaces — let members (not just owners) read their workspace row
-- ─────────────────────────────────────────────────────────────
-- RLS-AUDIT FIX (010a-inline): the 001 SELECT policy on workspaces was
-- `owner_id = auth.uid()`, which means an editor or viewer added via
-- memberships could not read the workspace row that backs the dashboard.
-- This adds a second permissive SELECT policy keyed on memberships so
-- non-owner members can see workspaces they belong to. The original
-- owner-only policy is left untouched (additive only, per Phase 4
-- ground rules — never drop existing policies).
create policy "Members read their workspaces (via memberships)"
  on public.workspaces for select
  using (
    exists (
      select 1 from public.memberships m
      where m.workspace_id = id and m.user_id = auth.uid()
    )
  );
