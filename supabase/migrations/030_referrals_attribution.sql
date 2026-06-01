-- marketingmagic · 030 — PLG loop, first slice (referrals + free-tier attribution)
--
-- Bet ② of the growth roadmap. Ships two self-reinforcing growth primitives,
-- both ADDITIVE + BACKWARD-COMPATIBLE (a workspace with no referral code and
-- the default attribution toggle behaves exactly as today):
--
--   1. referral_codes        — one stable invite code per workspace (the
--                              referrer). The /settings/referrals page renders
--                              ?ref=<code> against this.
--   2. referrals             — one row per attributed signup. Links the
--                              referrer workspace to the referred workspace so
--                              the settings page can count "signups you drove"
--                              and the reward grant is idempotent (UNIQUE on
--                              the referred workspace → a workspace can only be
--                              attributed once, ever).
--   3. workspaces.referral_bonus_posts  — the REWARD. A running tally of bonus
--                              monthly posts granted to the referrer. The post
--                              quota check (assertWithinPostQuota) adds this to
--                              the tier ceiling, so a successful referral simply
--                              raises the referrer's monthly post allowance —
--                              the least-invasive reward that needs no new
--                              usage-counter plumbing.
--   4. workspaces.attribution_enabled  — the "Made with marketingmagic" toggle.
--                              Default TRUE; only ever appended on HOBBY-plan
--                              posts (the plan gate lives in app code, not here,
--                              mirroring how entitlements are resolved). Paid
--                              workspaces never see the line regardless of the
--                              flag.
--
-- RLS: both new tables route SELECT through is_workspace_member (the same
-- helper every tenant table uses — migration 029 extended it for org staff, so
-- agency staff transparently see their client workspaces' referral data too).
-- WRITES go exclusively through the SERVICE ROLE (attribution + reward grants
-- happen server-side in trusted server actions), so there are NO public
-- INSERT/UPDATE policies — a user can't mint themselves codes or fake a
-- referral to farm bonus quota. This mirrors usage_counters (migration 002),
-- which is likewise service-role-only writable so users can't game their quota.

-- ─────────────────────────────────────────────────────────────
-- workspaces — reward column + attribution toggle
-- ─────────────────────────────────────────────────────────────
-- referral_bonus_posts: extra monthly posts granted by referrals, added to the
-- tier ceiling in assertWithinPostQuota. NOT NULL DEFAULT 0 so every existing
-- workspace reads as "no bonus" without a backfill.
alter table public.workspaces
  add column if not exists referral_bonus_posts integer not null default 0
    check (referral_bonus_posts >= 0);

-- attribution_enabled: workspace-level toggle for the "Made with marketingmagic"
-- line. Default TRUE (on for hobby out of the box); the plan gate (only hobby
-- ever shows it) lives in app code so paid workspaces are unaffected even with
-- the flag on.
alter table public.workspaces
  add column if not exists attribution_enabled boolean not null default true;

-- ─────────────────────────────────────────────────────────────
-- referral_codes — one stable code per workspace
-- ─────────────────────────────────────────────────────────────
-- workspace_id is UNIQUE: a workspace has exactly one invite code, created
-- lazily the first time the owner opens /settings/referrals. code is a short,
-- URL-safe, case-insensitively-unique token used in ?ref=<code>.
create table public.referral_codes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null unique references public.workspaces(id) on delete cascade,
  code text not null unique check (code ~ '^[a-zA-Z0-9]{6,16}$'),
  created_at timestamptz not null default now()
);

-- Case-insensitive lookup: the capture path resolves ?ref=<code> regardless of
-- the casing the visitor typed. A functional unique index also prevents two
-- codes that differ only by case.
create unique index referral_codes_code_lower_idx
  on public.referral_codes (lower(code));

create index referral_codes_workspace_idx
  on public.referral_codes(workspace_id);

alter table public.referral_codes enable row level security;

-- Members of the workspace (incl. org staff, via the extended
-- is_workspace_member) can read their own code to render the invite link. No
-- write policy: the code is minted by the service role in the settings action.
create policy "Members read their referral code"
  on public.referral_codes for select
  using (public.is_workspace_member(workspace_id));

-- ─────────────────────────────────────────────────────────────
-- referrals — one row per attributed signup
-- ─────────────────────────────────────────────────────────────
-- referred_workspace_id is UNIQUE: a workspace can be attributed to at most one
-- referrer, ever — the natural idempotency key for the reward grant (re-running
-- attribution can't double-credit). referrer_workspace_id is the workspace that
-- owns the code that drove this signup. Both FKs cascade-delete so removing a
-- workspace cleans up its referral edges.
create table public.referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_workspace_id uuid not null references public.workspaces(id) on delete cascade,
  referred_workspace_id uuid not null unique references public.workspaces(id) on delete cascade,
  -- The code as it was used at capture time (snapshot), so the audit trail
  -- survives even if the referrer later (hypothetically) rotated their code.
  code text not null,
  created_at timestamptz not null default now(),
  -- Guard against a self-referral edge sneaking in via a bug: a workspace can
  -- never refer itself.
  constraint referrals_no_self check (referrer_workspace_id <> referred_workspace_id)
);

create index referrals_referrer_idx
  on public.referrals(referrer_workspace_id);

alter table public.referrals enable row level security;

-- The REFERRER's members can read the referrals they drove (to show the count
-- on /settings/referrals). The referred workspace doesn't need to see this row.
-- No write policy: attribution is performed by the service role at workspace
-- creation, so a user can't fabricate a referral to farm bonus quota.
create policy "Referrer reads referrals they drove"
  on public.referrals for select
  using (public.is_workspace_member(referrer_workspace_id));
