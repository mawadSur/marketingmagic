-- marketingmagic · 002 — V1 additions
--
-- 1. workspaces.webhook_secret  — per-workspace HMAC secret for /api/webhooks/[workspace_id].
-- 2. posting_plans.parent_plan_id  — chain plans so KPI-weighted regen can reference its predecessor.
-- 3. posts.approved_at + posts.revoked_at  — surface trust-mode previews and audit timings cheaply.
-- 4. event_rules unique (workspace_id, event_type, template) — keep webhook rule dedup honest.

-- ─────────────────────────────────────────────────────────────
-- workspaces.webhook_secret
-- ─────────────────────────────────────────────────────────────
alter table public.workspaces
  add column if not exists webhook_secret text;

-- Backfill: anything without a secret gets a fresh random one.
update public.workspaces
  set webhook_secret = encode(gen_random_bytes(32), 'hex')
  where webhook_secret is null;

-- ─────────────────────────────────────────────────────────────
-- posting_plans.parent_plan_id
-- ─────────────────────────────────────────────────────────────
alter table public.posting_plans
  add column if not exists parent_plan_id uuid references public.posting_plans(id) on delete set null;

create index if not exists posting_plans_parent_idx on public.posting_plans(parent_plan_id);

-- ─────────────────────────────────────────────────────────────
-- posts.approved_at + posts.revoked_at
-- ─────────────────────────────────────────────────────────────
alter table public.posts
  add column if not exists approved_at timestamptz,
  add column if not exists revoked_at timestamptz;

-- ─────────────────────────────────────────────────────────────
-- event_rules dedup
-- ─────────────────────────────────────────────────────────────
create unique index if not exists event_rules_uniq
  on public.event_rules(workspace_id, event_type, md5(template));
