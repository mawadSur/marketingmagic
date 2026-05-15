-- marketingmagic · 017 — Discord ↔ Supabase user link table (Phase 4.7)
--
-- Until now `approvals.user_id` was always the workspace owner for every
-- Discord button click, with the real Discord actor name stashed as free
-- text in `approvals.diff`. That makes the audit row a lie the moment a
-- non-owner member approves something from Discord.
--
-- Fix: a small join table that maps (workspace_id, discord_user_id) →
-- auth.users.id. The Discord action handler looks the actor up here and
-- attributes the approval to the real Supabase user. On miss, it still
-- falls back to the owner AND sends the actor an ephemeral message with a
-- signed link-claim URL — clicking it (while logged in to mm) writes a
-- row here, so the *next* click attributes correctly.
--
-- Note on numbering: 016 was taken today by fix_rls_recursion. A separate
-- unmerged branch (phase-6.6-competitor-watch) also has a local 016 — it
-- will rebase forward to 018 on merge.

create table public.discord_links (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- Discord snowflake — text because the IDs are >53-bit and JSON round-trips
  -- silently mangle them as numbers. Matches integrations.target_channel_id.
  discord_user_id text not null,
  member_user_id uuid not null references auth.users(id) on delete cascade,
  linked_at timestamptz not null default now(),
  primary key (workspace_id, discord_user_id)
);

-- Reverse lookup: "what Discord identities does this Supabase user have?"
-- Handy for an eventual settings page; also cheap to maintain.
create index discord_links_member_user_idx on public.discord_links(member_user_id);

alter table public.discord_links enable row level security;

-- ─────────────────────────────────────────────────────────────
-- RLS
-- ─────────────────────────────────────────────────────────────
-- Read: any member of the workspace. The link rows aren't secret per se —
-- they reveal which Discord usernames belong to which teammates, which is
-- inside-the-team data and an editor needs it to debug attribution.
create policy "Members read discord_links"
  on public.discord_links for select
  using (public.is_workspace_member(workspace_id));

-- Insert: an authed user can only link THEIR OWN Supabase id to a Discord
-- id, and only inside a workspace they're a member of. This is the path
-- used by /integrations/discord/link?token=… — the page passes the
-- workspace_id from the signed token and uses the user's cookie session,
-- so RLS enforces both constraints without trusting the URL.
create policy "Self-link discord_links"
  on public.discord_links for insert
  to authenticated
  with check (
    member_user_id = auth.uid()
    and public.is_workspace_member(workspace_id)
  );

-- Delete: owner only. user_owns_workspace was added in migration 016.
-- Members can't unlink each other; owners can clean up departed teammates.
create policy "Owner deletes discord_links"
  on public.discord_links for delete
  using (public.user_owns_workspace(workspace_id));

-- No update policy — the row is effectively immutable once written
-- (delete + re-insert if you ever need to rebind, which is rare).
