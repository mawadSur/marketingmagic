-- marketingmagic · 038 — allow 'disconnected' status on social_accounts
--
-- Adds user-initiated disconnect for every channel. We can't hard-delete a
-- connected account: posts.social_account_id is `references social_accounts(id)
-- on delete restrict` (001_init.sql), so once a workspace has posted through an
-- account the row can't be removed without a 23503 FK violation — and deleting
-- it would orphan post history anyway. So disconnect is a SOFT state: flip
-- status to 'disconnected' and wipe credentials. The dispatcher/cron only act
-- on status='connected', the listing + channel-quota count exclude
-- 'disconnected', and reconnecting upserts status back to 'connected'.
--
-- The status CHECK is an inline column-level check (001_init.sql line 135), so
-- Postgres named it social_accounts_status_check. Drop + re-add with the new
-- value appended. 'connected', 'expired', 'revoked' are unchanged.

alter table public.social_accounts
  drop constraint if exists social_accounts_status_check;

alter table public.social_accounts
  add constraint social_accounts_status_check
  check (status in ('connected', 'expired', 'revoked', 'disconnected'));
