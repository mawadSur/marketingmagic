-- marketingmagic · 028 — allow 'tiktok' in the channel CHECK constraints
--
-- Adds TikTok (OAuth connect + chunked video publishing) as a channel. The
-- only column-level CHECK that enumerates channels is social_accounts.channel
-- (migration 001_init.sql). posts.channel is declared `text not null` with NO
-- CHECK constraint, so it already accepts 'tiktok' — nothing to alter there.
--
-- Without this migration, the TikTok OAuth callback's upsert into
-- social_accounts would be rejected at the DB layer with a 23514
-- check_violation (the same silent-failure class as the Founder-plan bug fixed
-- in 025): PostgREST returns the error, supabase-js surfaces it as
-- { data: null, error }, and the connect flow redirects with that DB message.
--
-- Inline column-level checks use Postgres's implicit `<table>_<column>_check`
-- naming, so the target constraint is social_accounts_channel_check. We drop
-- and re-add it with 'tiktok' appended to the allowlist.

alter table public.social_accounts
  drop constraint if exists social_accounts_channel_check;

alter table public.social_accounts
  add constraint social_accounts_channel_check
  check (channel in ('x', 'instagram', 'facebook', 'threads', 'bluesky', 'linkedin', 'tiktok'));
