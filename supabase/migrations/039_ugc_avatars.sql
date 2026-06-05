-- marketingmagic · 039 — UGC avatars (Higgsfield avatar workflow)
--
-- The UGC-style content workflow lets a workspace upload/select a reusable
-- "avatar" (a portrait the on-screen presenter is generated from) and reuse it
-- across renders — both ad-hoc (/video UGC tab) and planner-driven (the plan
-- form's "Generate UGC video" opt-in pre-populates the render from the chosen
-- avatar so the user just approves).
--
-- Distinct from the per-render reference-image upload (030): that bucket already
-- holds the raw photos. This table is the NAMED, REUSABLE layer on top — a
-- workspace picks one of its saved avatars instead of re-uploading every time.
-- The image still lives in the `reference-image` bucket (030); we store only its
-- storage path + public URL here, so no new bucket is needed.
--
-- Gated at the application layer behind REFERENCE_VIDEO_ENABLED — nothing here
-- ships live until the flag is on AND a workspace adds a Higgsfield key.

-- ─────────────────────────────────────────────────────────────
-- avatars — a workspace's reusable UGC presenter portraits
-- ─────────────────────────────────────────────────────────────
create table if not exists public.avatars (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- Human label shown in the picker ("Founder", "Spokesperson Jane", …).
  name text not null,
  -- Storage path in the `reference-image` bucket (030):
  -- `<workspace_id>/<upload_id>/<file>`. The bytes/public URL are served from
  -- there; we keep the path for cleanup + to mint fresh public URLs.
  image_path text not null,
  -- Cached public URL for the picker thumbnail. The bucket is public, so this
  -- is stable; re-derivable from image_path via getPublicUrl if ever needed.
  image_url text not null,
  -- Default avatar for planner pre-population. At most one per workspace is the
  -- "primary"; enforced by the partial unique index below. The planner picks
  -- the primary (or the most recent) when the user opts a plan into UGC video.
  is_primary boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists avatars_workspace_idx on public.avatars(workspace_id);

-- At most one primary avatar per workspace. Partial unique index so non-primary
-- rows don't collide. The data layer flips the old primary off in the same
-- transaction when a new one is set.
create unique index if not exists avatars_one_primary_per_workspace
  on public.avatars(workspace_id)
  where is_primary;

create trigger avatars_set_updated_at
  before update on public.avatars
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────
-- RLS — workspace-scoped, mirrors the established member-gated pattern
-- ─────────────────────────────────────────────────────────────
-- Members of the owning workspace may read their avatars; all writes go through
-- the service role (the upload/save server actions), matching how social
-- accounts + video jobs are written. No public write policy.
alter table public.avatars enable row level security;

create policy "avatars: members read own workspace"
  on public.avatars for select
  using (public.is_workspace_member(workspace_id));
