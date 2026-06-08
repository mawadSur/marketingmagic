-- marketingmagic · 052 — post_tags (auto-generated post tags)
--
-- Adds a first-class `tags` column to public.posts:
--
--   posts.tags  text[] not null default '{}'
--
-- WHAT THIS IS (and how it differs from migration 014 hashtag_usage):
--   • 014's hashtag_usage is a per-workspace × per-channel HISTORY table that
--     powers the recency-weighted RECOMMENDER. It is recommendation-only and
--     NEVER auto-applies anything to a draft — the /queue chip row is the only
--     binding surface, and tags live inline in posts.text as a trailing
--     "#tag #tag" block.
--   • This migration is the GENERATION + PERSISTENCE layer. It stores the
--     auto-generated tag set for a post as STRUCTURED DATA on the row, so the
--     generator can populate it at plan time and the editor can surface it as
--     editable chips without round-tripping through posts.text parsing.
--
-- WHY A COLUMN (not a normalized post_tags table):
--   • Tags are a small, bounded set (≤30, channel caps far lower) that is
--     ALWAYS read and written as a whole alongside the post — never queried
--     independently ("find every post with tag X" is the recommender's job,
--     and that already has its own indexed hashtag_usage table). A child
--     table would add a join + a write-fan-out for zero query benefit.
--   • Postgres text[] round-trips cleanly through PostgREST/supabase-js as a
--     JS string[], so the app layer (src/lib/tags/*) treats it as a plain
--     array with no ORM ceremony.
--   • Atomic with the row: a post insert/update carries its tags in the same
--     statement, so there's no partial-write window where a post exists with
--     stale or missing tags.
--
-- NORMALIZATION CONTRACT (enforced application-side in src/lib/tags/generate.ts
-- and mirrored by the CHECK below, exactly like hashtag_usage in 014):
--   • lowercase, no leading '#'
--   • ASCII letter/digit/underscore only is an app-layer concern (the regex
--     lives in src/lib/hashtags/extract.ts); the CHECK here is the same
--     belt-and-suspenders guard 014 uses so a bad direct insert can't poison
--     the data: every element must equal its lowercase form and not start
--     with '#'. Empty-string elements are rejected.
--
-- RELATIONSHIP TO posts.text:
--   • posts.tags is the source of truth for "which tags belong on this post".
--   • The existing setPostHashtagsAction (014) still mirrors the chosen tags
--     into a trailing #block in posts.text so the published copy renders the
--     hashtags — that path is unchanged. This column adds the structured
--     mirror; it does not replace the inline render.
--   • The hashtag_usage recommender continues to learn from posts.text via the
--     backfill, so nothing about the recommendation loop changes.
--
-- ADDITIVE + IDEMPOTENT: `add column if not exists` with a not-null default
-- means existing rows backfill to '{}' (no tags) with zero downtime, and the
-- migration is safe to re-run.

alter table public.posts
  add column if not exists tags text[] not null default '{}';

-- Guard the contract at the DB boundary. A CHECK constraint cannot contain a
-- subquery (Postgres rejects "cannot use subquery in check constraint",
-- SQLSTATE 0A000), so we can't inline an unnest() over the array. Instead we
-- assert the per-element invariants the app normalizer guarantees via an
-- IMMUTABLE helper function — a plain function call IS allowed inside a CHECK.
-- Same belt-and-suspenders split as migration 014 (full ASCII-only rule stays
-- in the app layer, src/lib/hashtags/extract.ts); here we enforce: every
-- element is lowercase, has no leading '#', and is 1-100 chars.
create or replace function public.tags_are_normalized(tags text[])
returns boolean
language sql
immutable
as $$
  -- TRUE when the array is null/empty OR every element satisfies the contract.
  -- bool_and over an empty set is TRUE, so '{}' passes cleanly.
  select coalesce(
    bool_and(t = lower(t) and t !~ '^#' and length(t) between 1 and 100),
    true
  )
  from unnest(coalesce(tags, '{}')) as t;
$$;

do $$
begin
  if not exists (
    select 1
    from information_schema.constraint_column_usage
    where table_schema = 'public'
      and table_name = 'posts'
      and constraint_name = 'posts_tags_normalized_chk'
  ) then
    alter table public.posts
      add constraint posts_tags_normalized_chk
      check (public.tags_are_normalized(tags));
  end if;
end $$;

comment on column public.posts.tags is
  'Auto-generated, user-editable tag set for this post (migration 052). Normalized lowercase, no leading #, ASCII letter/digit/underscore, ≤30 elements / channel cap. Structured source of truth for the tag chips in /queue; the inline #block in posts.text is the published render. Distinct from hashtag_usage (014), which is the recommendation history. Empty {} = no tags (correct for no-tag channels like Bluesky / X-by-default).';

-- RLS: posts already enforces workspace-scoped row-level security
-- (see 001_init.sql). Adding a column inherits the table's policies — no new
-- policy is required. Documented here so the absence isn't read as an
-- oversight.
