-- marketingmagic · 032 — PLG loop bet ② remaining slices
--
-- Builds on 031 (referral codes + free-tier attribution). Two ADDITIVE,
-- BACKWARD-COMPATIBLE primitives:
--
--   1. preview_shares        — persists the minimum needed to re-render an
--                              anonymous /start preview plan under a short,
--                              unguessable SLUG, so the visitor can share a
--                              stable read-only link that unfurls on social
--                              (dynamic OG card). Today a preview lives entirely
--                              in a signed token in the URL (24h TTL, no DB) —
--                              good for the just-generated view, but too long /
--                              too ephemeral to paste into a tweet. A share row
--                              gives a short URL with a longer life.
--
--   2. referrals.vested_at   — anti-farming. In 031 the +5 referral bonus was
--                              granted at the referred workspace's CREATION, so
--                              throwaway signups could farm a referrer's quota.
--                              We now VEST the reward only when the referred
--                              workspace ships its FIRST post (status → 'posted').
--                              vested_at records the one-time grant so it can
--                              never double-credit.
--
-- RLS posture mirrors 031: writes (and the slug read) go through the SERVICE
-- ROLE in trusted server code. preview_shares holds ONLY preview content
-- (channel, handle, plan, voice summary) — never account data — and has NO
-- public policies: the slug is an unguessable capability and the read is
-- performed server-side by the service role, so nothing leaks via PostgREST.

-- ─────────────────────────────────────────────────────────────
-- preview_shares — persisted, shareable anonymous preview plans
-- ─────────────────────────────────────────────────────────────
-- slug: short, URL-safe, unguessable capability token used in /p/<slug>.
-- UNIQUE so a slug maps to exactly one share. payload: the preview content
-- needed to re-render read-only (the same shape the signed preview token
-- carried). expires_at: a generous TTL (set in app code) so a shared link
-- outlives the 24h preview token but still ages out eventually.
create table public.preview_shares (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-zA-Z0-9_-]{8,40}$'),
  -- Snapshot of the preview content ONLY. No workspace/user/account data: an
  -- anonymous visitor generated this before signing up, and the shared view is
  -- read-only marketing copy. Shape mirrors the signed preview token payload
  -- (channel, handle, niche_hint, plan, voice_summary, source).
  payload jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz
);

create index preview_shares_slug_idx on public.preview_shares(slug);
-- Sweep helper for a future cron that prunes expired shares.
create index preview_shares_expires_idx on public.preview_shares(expires_at);

alter table public.preview_shares enable row level security;

-- NO public policies. With RLS enabled and no SELECT/INSERT policy, anon/auth
-- PostgREST callers can neither read nor write this table — the share is
-- minted and read EXCLUSIVELY by the service role in trusted server code
-- (createPreviewShare / getPreviewShare), where the slug acts as the
-- capability. This mirrors how 031 keeps referral writes service-role-only.

-- ─────────────────────────────────────────────────────────────
-- referrals.vested_at — reward vesting (anti-farming)
-- ─────────────────────────────────────────────────────────────
-- NULL = referral attributed but the referred workspace hasn't shipped its
-- first post yet (reward PENDING). Set to now() exactly once, when that first
-- post reaches 'posted' and we grant the referrer the +5 bonus. The "flip NULL
-- → now() in a conditional UPDATE" is the idempotency key: a second attempt
-- matches zero rows (vested_at is no longer NULL) so the bonus is never granted
-- twice. Existing 031 referrals backfill as NULL (pending) — harmless, since a
-- workspace that has already posted simply vests on its next finalised post,
-- and brand-new referrals vest correctly going forward.
alter table public.referrals
  add column if not exists vested_at timestamptz;

-- Partial index to find a referred workspace's still-pending referral fast
-- (the vesting path filters on referred_workspace_id where vested_at is null).
create index if not exists referrals_unvested_idx
  on public.referrals(referred_workspace_id)
  where vested_at is null;
