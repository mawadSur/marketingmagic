-- marketingmagic · 041 — enforce workspace match between a group draft and its group
--
-- Hardening for 040. facebook_group_drafts carries BOTH workspace_id and
-- group_id (FK → facebook_groups.id). The single-column FK guarantees the group
-- EXISTS, but NOT that the draft's workspace_id equals the group's workspace_id.
-- So at the DB layer, a draft in workspace A could reference a group in
-- workspace B. The app layer already prevents this (loadGroup() scopes the group
-- to the active workspace before inserting a draft), and the draft RLS policy
-- gates on the draft's own workspace_id — but multi-tenant isolation should hold
-- as a DB invariant, not rely on the app being bug-free. A future code path,
-- a direct service-role write, or a mistaken RLS change shouldn't be able to
-- cross-link workspaces.
--
-- Fix: a COMPOSITE foreign key on (group_id, workspace_id) → facebook_groups
-- (id, workspace_id). (A CHECK constraint can't express this — Postgres forbids
-- subqueries in CHECK.) This makes the draft's workspace_id provably equal to
-- its group's workspace_id, which in turn makes the existing
-- is_workspace_member(workspace_id) RLS policy correct by invariant.

-- 1. The composite FK target must be a unique key. `id` is already the PK
--    (unique on its own), so (id, workspace_id) is trivially unique — this
--    constraint just lets it be referenced by a composite FK.
alter table public.facebook_groups
  add constraint facebook_groups_id_workspace_key unique (id, workspace_id);

-- 2. Drop the original single-column FK (inline FKs are named
--    <table>_<column>_fkey by Postgres) and replace it with the composite one.
--    Keep ON DELETE CASCADE so deleting a group still removes its drafts.
alter table public.facebook_group_drafts
  drop constraint if exists facebook_group_drafts_group_id_fkey;

alter table public.facebook_group_drafts
  add constraint facebook_group_drafts_group_workspace_fkey
  foreign key (group_id, workspace_id)
  references public.facebook_groups (id, workspace_id)
  on delete cascade;
