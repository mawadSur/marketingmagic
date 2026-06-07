-- marketingmagic · 044 — Client self-connect tokens (Agency Proof Engine, bet ③)
--
-- A tokenized link an AGENCY sends a CLIENT so the client connects THEIR OWN
-- social channels — removing the credential-handoff friction of the client
-- DMing the agency a password. The link lands on an unauthenticated page
-- (/connect/[token]) that kicks off the EXISTING per-channel OAuth initiate
-- flow, but attributes the connected account to the correct client workspace.
--
-- This mirrors the tokenized client portal (migration 029 client_portal_tokens
-- + /client/[token]) one-for-one: SHA-256(raw) stored (never the raw token),
-- short expiry, revocation, a hardened service-role resolver that scopes every
-- read to exactly one workspace_id. The two token tables are deliberately
-- SEPARATE — a portal token can approve/view reports; a self-connect token can
-- ONLY drive an OAuth connect for its workspace. Different blast radius, so
-- different grant.
--
-- SECURITY MODEL (identical to client_portal_tokens, see 029):
--   • The /connect/[token] surface is UNAUTHENTICATED — no auth.uid(), so RLS
--     does not protect it. The token resolves (service-role) to exactly one
--     workspace_id, and the OAuth initiate it drives stamps that workspace_id
--     into the OAuth `state` the existing callbacks already trust. The token is
--     the entire trust boundary for that path.
--   • RLS below is ONLY for the org-staff management UI (mint / list / revoke a
--     self-connect link for a client workspace they manage). It routes through
--     the existing is_workspace_member(workspace_id) helper, which migration 029
--     extended to include org staff — so an org member can only ever see/manage
--     self-connect tokens for client workspaces in THEIR org. No cross-org leak.

create table public.client_self_connect_tokens (
  id uuid primary key default gen_random_uuid(),
  -- The client workspace the connected social account will be attributed to.
  -- CASCADE so deleting a client workspace cleans up its self-connect links.
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- SHA-256(raw token), lowercase hex. The raw token is NEVER stored — a DB
  -- leak can't be replayed. Unique so the resolver can look up by hash alone.
  token_hash text not null unique,
  -- Free-text label for the agency's own bookkeeping (e.g. the client contact).
  label text,
  -- Short-lived, revocable grant. expires_at NULL = no expiry (the mint path
  -- defaults to a finite expiry); revoked_at NOT NULL = hard-revoked.
  expires_at timestamptz,
  revoked_at timestamptz,
  -- Audit: who minted it. SET NULL on user delete keeps the historical row.
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index client_self_connect_tokens_workspace_idx
  on public.client_self_connect_tokens(workspace_id);

-- Active-token lookup: hash → workspace, skipping revoked rows. The resolver
-- still checks expires_at at read time (mirrors client_portal_tokens_hash_idx).
create index client_self_connect_tokens_hash_idx
  on public.client_self_connect_tokens(token_hash)
  where revoked_at is null;

alter table public.client_self_connect_tokens enable row level security;

-- Members of the workspace (which, via the 029-extended is_workspace_member,
-- includes org staff of the workspace's organization) can read / mint / revoke
-- self-connect links for that workspace. No raw token is ever stored, so a
-- SELECT exposing token_hash is safe. The unauthenticated /connect/[token] path
-- does NOT use these policies — it goes through the service role.
create policy "Members read self-connect tokens"
  on public.client_self_connect_tokens for select
  using (public.is_workspace_member(workspace_id));

-- Inserts come from a server action AFTER an org-member authz check, written
-- with the authed (RLS-backed) client; the WITH CHECK keeps an insert scoped to
-- a workspace the caller can already see and pins created_by to the caller.
create policy "Members insert self-connect tokens"
  on public.client_self_connect_tokens for insert
  to authenticated
  with check (
    public.is_workspace_member(workspace_id)
    and (created_by is null or created_by = auth.uid())
  );

create policy "Members update self-connect tokens"
  on public.client_self_connect_tokens for update
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

create policy "Members delete self-connect tokens"
  on public.client_self_connect_tokens for delete
  using (public.is_workspace_member(workspace_id));
