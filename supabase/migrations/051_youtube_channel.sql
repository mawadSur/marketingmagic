-- marketingmagic · 051 — allow 'youtube' in the channel CHECK constraint
--
-- Adds YouTube (Google OAuth connect + resumable Data API v3 video publishing)
-- as the 8th channel. The only column-level CHECK that enumerates channels is
-- social_accounts.channel (migration 001_init.sql, last widened in 028 for
-- TikTok). posts.channel is declared `text not null` with NO CHECK constraint,
-- so it already accepts 'youtube' — nothing to alter there.
--
-- Without this migration, the YouTube OAuth callback's upsert into
-- social_accounts would be rejected at the DB layer with a 23514
-- check_violation: PostgREST returns the error, supabase-js surfaces it as
-- { data: null, error }, and the connect flow redirects with that DB message.
--
-- Inline column-level checks use Postgres's implicit `<table>_<column>_check`
-- naming, so the target constraint is social_accounts_channel_check. We drop
-- and re-add it with 'youtube' appended to the allowlist (preserving the full
-- set from 028 plus the new value).

alter table public.social_accounts
  drop constraint if exists social_accounts_channel_check;

alter table public.social_accounts
  add constraint social_accounts_channel_check
  check (channel in ('x', 'instagram', 'facebook', 'threads', 'bluesky', 'linkedin', 'tiktok', 'youtube'));
