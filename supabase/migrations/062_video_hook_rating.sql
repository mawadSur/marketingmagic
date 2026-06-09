-- marketingmagic · 062 — video hook RATING (Hormozi slice 2 follow-up)
--
-- Slice 2 (migration 061) DESCRIBES a hook (transcript, hooks, first-5s,
-- pattern interrupts, on-screen text). Hormozi's mechanic is to GRADE it: a hook
-- either stops the scroll or it doesn't, so a creator needs a number to compare
-- clips and know what to fix. This adds the rating produced by the same analysis
-- pass — no new provider call, just two more columns persisted from the existing
-- analyzeVideo() output.
--
--   - `hook_score`   — the headline 0–100 hook strength, denormalised into its
--                      own int column so list/sort/filter ("show my strongest
--                      hooks") is a plain indexed query, not a jsonb dig.
--   - `hook_rating`  — the full graded object: { score, verdict, criteria[],
--                      improvements[] }. Shape is owned by the analyze module
--                      (HookRating), persisted verbatim as jsonb — same contract
--                      as visual_breakdown in 061.
--
-- Both are nullable: rows written by 061 (pre-rating) stay valid, and a re-run
-- UPSERTs the rating in. No backfill — old rows simply have no score until
-- re-analysed.

alter table public.video_analysis
  -- Headline 0–100 hook strength (CHECK keeps a mis-write in range). Denormalised
  -- from hook_rating.score for cheap sort/filter; the jsonb keeps the full grade.
  add column if not exists hook_score integer
    check (hook_score is null or (hook_score >= 0 and hook_score <= 100)),
  -- The full graded rating object (score + verdict + per-criterion sub-scores +
  -- improvements). Shape owned by the analyze module, not the DB.
  add column if not exists hook_rating jsonb;

-- "Show my strongest hooks" / sort-by-score reads filter by workspace then order
-- by score. Partial index skips the not-yet-rated rows.
create index if not exists video_analysis_hook_score_idx
  on public.video_analysis(workspace_id, hook_score desc)
  where hook_score is not null;
