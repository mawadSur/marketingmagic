-- marketingmagic · 060 — post_variation_lineage (hook×body variation lineage)
--
-- Adds two nullable, additive columns to public.posts so a generated
-- variation can trace back to the post/concept it was spun from:
--
--   posts.parent_post_id     uuid references public.posts(id) on delete set null
--   posts.variation_group_id uuid
--
-- WHAT THIS IS (Hormozi organic-first slice #4 — "variation lineage"):
--   The hook×body variation generator (slice #3, src/lib/variations/*) turns
--   ONE source post into a matrix of N drafts (default 10 hooks × 3 bodies =
--   30). Lineage lets us answer two questions later:
--     • "which source did this draft come from?"  → parent_post_id
--     • "which generation batch produced it?"      → variation_group_id
--   A whole 30-draft batch shares ONE variation_group_id (minted per run);
--   every draft in the batch points its parent_post_id at the source post.
--
-- WHY TWO COLUMNS (not a join table):
--   • Lineage is ALWAYS read alongside the post row ("show me the siblings of
--     this draft" / "trace this draft to its source"), never queried as a
--     standalone fact. A child table would add a join + write fan-out for zero
--     query benefit — same reasoning as migration 052's tags column.
--   • This is the cheap groundwork that ENABLES a future learning loop (when
--     real outcome volume exists) without committing to the loop now. The
--     organic-first review (docs/designs/hormozi-video-strategy-review.md)
--     explicitly defers scoring/ROAS; this migration carries no such weight.
--
-- parent_post_id semantics:
--   • Self-referential FK to public.posts(id). ON DELETE SET NULL preserves the
--     variation draft if the source post is hard-deleted — we lose the link,
--     not the draft (same audit-preserving choice as posts.source_id /
--     content_goals.parent_goal_id).
--   • NULL for posts that are NOT variations (the overwhelming majority).
--
-- variation_group_id semantics:
--   • A plain uuid (NOT a FK — it does not point at a row; it's a batch tag,
--     like idea_id groups an atom's channel variants). All drafts minted in one
--     "Generate 30 variations" run share the value so the queue can group them.
--   • NULL for non-variation posts.
--
-- ADDITIVE + IDEMPOTENT: `add column if not exists` on both columns means
-- existing rows backfill to NULL (not variations) with zero downtime, and the
-- migration is safe to re-run.

alter table public.posts
  add column if not exists parent_post_id uuid references public.posts(id) on delete set null;

alter table public.posts
  add column if not exists variation_group_id uuid;

-- Index the batch tag so "fetch every draft in this variation group" (the
-- queue grouping query) is a cheap indexed lookup rather than a seq scan.
-- Partial index — only the small slice of posts that actually carry a group.
create index if not exists posts_variation_group_id_idx
  on public.posts (variation_group_id)
  where variation_group_id is not null;

-- Index the self-FK so "find every variation spun from this source post" is
-- also indexed. Partial — only the variation rows carry a parent.
create index if not exists posts_parent_post_id_idx
  on public.posts (parent_post_id)
  where parent_post_id is not null;

comment on column public.posts.parent_post_id is
  'Migration 060: the source post this row was generated as a variation OF (hook×body variation generator, src/lib/variations). Self-FK to posts(id); ON DELETE SET NULL preserves the variation draft if the source is deleted. NULL for non-variation posts. Distinct from experiments.parent_post_id (that is the A/B parent on the experiments table).';

comment on column public.posts.variation_group_id is
  'Migration 060: batch tag shared by every draft minted in one "Generate 30 variations" run. A plain uuid (not a FK) — groups a generation batch the way idea_id groups an atom''s channel variants. NULL for non-variation posts.';

-- RLS: posts already enforces workspace-scoped row-level security
-- (see 001_init.sql). Adding columns inherits the table's policies — no new
-- policy is required. Documented here so the absence isn't read as an oversight.
