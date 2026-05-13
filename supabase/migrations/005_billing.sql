-- marketingmagic · 005 — Stripe billing + tiered plans
--
-- 1. workspaces gains plan + Stripe identifiers + subscription_status. The
--    plan column has a default of 'hobby' so every existing workspace stays
--    on the free tier until they hit Checkout.
-- 2. usage_counters tracks per-(workspace, month) post + image generation
--    counts. The gating helpers in src/lib/billing/limits.ts read this; the
--    increment helpers in src/lib/billing/usage.ts upsert into it.
--    Members can read so the /settings/billing page can show usage, but
--    only the service role writes — we don't want clients tampering with
--    their own quota.

-- ─────────────────────────────────────────────────────────────
-- workspaces — billing columns
-- ─────────────────────────────────────────────────────────────
alter table public.workspaces
  add column if not exists plan text not null default 'hobby'
    check (plan in ('hobby', 'pro', 'agency')),
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text,
  add column if not exists subscription_status text;

create index if not exists workspaces_stripe_customer_idx
  on public.workspaces(stripe_customer_id)
  where stripe_customer_id is not null;

-- ─────────────────────────────────────────────────────────────
-- usage_counters — monthly buckets per workspace
-- ─────────────────────────────────────────────────────────────
create table if not exists public.usage_counters (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  month text not null check (month ~ '^\d{4}-\d{2}$'),
  posts_generated integer not null default 0,
  images_generated integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, month)
);

create index if not exists usage_counters_workspace_idx
  on public.usage_counters(workspace_id, month desc);

alter table public.usage_counters enable row level security;

-- Members can read their own usage so /settings/billing can render the bar.
create policy "Members can read usage counters"
  on public.usage_counters for select
  using (public.is_workspace_member(workspace_id));

-- Writes are service-role only — no public insert/update policy. The
-- billing increment helpers always go through supabaseService().
