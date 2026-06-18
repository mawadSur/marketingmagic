-- marketingmagic · 067 — content_hash (exact-duplicate detection on posts)
--
-- Adds one nullable, additive column to public.posts:
--
--   posts.content_hash  text  (nullable)
--
-- WHAT THIS IS (content de-duplication, foundation slice):
--   Every inserted post now carries a SHA-256 hex digest of its NORMALIZED
--   text (src/lib/dedup/similarity.ts → hashContent). Normalization lower-cases,
--   strips accents, URLs, @mentions / #hashtags, and punctuation, then collapses
--   whitespace — so two posts that differ only in casing, links, tags, or spacing
--   hash to the SAME value. The hash is the cheap, indexed key for the EXACT-dup
--   check: "have we already queued or posted this exact thing?" is a single
--   equality lookup rather than scanning text. It is channel-AGNOSTIC on purpose
--   — the same copy on X and Instagram is still a duplicate.
--
-- WHY HASH-OF-NORMALIZED (not the raw text, not a generated column):
--   • The dedup gate (src/lib/dedup/gate.ts) loads a recent corpus and compares
--     candidate hashes against stored hashes in-app. Storing the digest lets that
--     comparison be an O(1) Set membership test plus an indexed DB lookup, instead
--     of re-normalizing + re-hashing every historical row on every generation run.
--   • It is computed in TypeScript (Node `crypto`), NOT a Postgres generated
--     column: the normalization rules live in one place (similarity.ts) and must
--     stay byte-for-byte identical to the near-dup path, which is pure app code.
--     A SQL-side reimplementation would be a second source of truth that could
--     silently drift. So this column is plain text, written by the app on insert.
--
-- NEAR-duplicates are computed IN-APP, not here:
--   Exact dups are this hash. NEAR dups (e.g. a reworded post, > NEAR_DUP_THRESHOLD
--   trigram-Jaccard similarity) cannot be an equality lookup — they need the full
--   pairwise similarity scan in src/lib/dedup/gate.ts against the loaded corpus.
--   This migration intentionally carries NO similarity machinery; it only makes
--   the exact-match fast path indexable. Documented so the absence isn't read as
--   an oversight.
--
-- NULLABLE, NOT defaulted: legacy rows predate the hash and stay NULL (we never
--   computed it for them). NULL means "no hash recorded" — the partial index and
--   the in-app gate both skip NULLs, so old rows simply don't participate in the
--   exact fast path (they can still match via the text-derived hash the gate
--   computes on the fly). New rows on every insert path write a non-null hash.
--
-- ADDITIVE + IDEMPOTENT: `add column if not exists` + `create index if not exists`
--   means existing rows backfill to NULL with zero downtime and the migration is
--   safe to re-run.
--
-- RLS: posts already enforces workspace-scoped row-level security (see
--   001_init.sql). Adding a column inherits the table's policies — no new policy
--   is required. Documented here so the absence isn't read as an oversight.

alter table public.posts
  add column if not exists content_hash text;

-- Workspace-scoped, partial index on (workspace_id, content_hash). The exact-dup
-- lookup is always "within THIS workspace, does any row share this hash?", so the
-- workspace_id leading column lets Postgres seek directly to the tenant before
-- matching the digest. Partial (content_hash is not null) keeps the index small —
-- only rows that actually carry a hash are indexed; legacy NULL rows are excluded.
create index if not exists posts_workspace_content_hash_idx
  on public.posts (workspace_id, content_hash)
  where content_hash is not null;

comment on column public.posts.content_hash is
  'Migration 067: SHA-256 hex of the NORMALIZED post text (src/lib/dedup/similarity.ts → hashContent — lowercased, accent/URL/@/#/punctuation-stripped, whitespace-collapsed). The indexed key for channel-agnostic EXACT-duplicate detection in the dedup gate (src/lib/dedup/gate.ts). NEAR-dups are computed in-app via trigram Jaccard, not here. NULL for legacy rows that predate the column; every new insert path writes a non-null hash.';
