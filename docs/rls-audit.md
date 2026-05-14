# RLS Audit — Phase 4 (Self-Serve Growth)

**Date:** 2026-05-14
**Migrations covered:** `001` through `010`
**Audit goal:** confirm every business-data table's RLS policy honours
**membership** (workspaces.owner_id OR memberships.user_id), not just owner.
Editors and viewers must be able to do their jobs once the team UI is live.

## Audit rules

The codebase's central trust check is `public.is_workspace_member(ws_id)`
from `001_init.sql:72-85`:

```sql
create or replace function public.is_workspace_member(ws_id uuid)
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from public.workspaces w
    where w.id = ws_id and w.owner_id = auth.uid()
  ) or exists (
    select 1 from public.memberships m
    where m.workspace_id = ws_id and m.user_id = auth.uid()
  );
$$;
```

Any policy that uses `is_workspace_member(workspace_id)` is automatically
membership-aware. Policies that bypass this and key directly on
`owner_id = auth.uid()` are flagged as **Issue** unless ownership is the
deliberate trust boundary (e.g. workspace settings, team management).

Status legend: **✓ Compliant** · **⚠ Issue** · **✓ Fixed in 010**

---

## Table-by-table

### `public.workspaces`

| Op | Policy | Condition | Status |
|----|--------|-----------|--------|
| SELECT | Members can read their workspaces (001) | `owner_id = auth.uid()` | ⚠ Owner-only — non-owner members couldn't read their own workspace row. |
| SELECT | Members read their workspaces (via memberships) (010) | `exists (memberships where workspace_id = id and user_id = auth.uid())` | ✓ Fixed in 010 |
| UPDATE | Owners can update their workspaces (001) | `owner_id = auth.uid()` | ✓ Compliant — workspace metadata (slug/name/billing) is intentionally owner-only |
| INSERT | Authenticated users can create workspaces (001) | `owner_id = auth.uid()` | ✓ Compliant — caller must be inserting themselves as owner |

**Result:** ✓ Fixed in 010. The new permissive SELECT policy lets editors
and viewers read the workspace row via `getActiveWorkspaceOrRedirect`.

### `public.memberships`

| Op | Policy | Condition | Status |
|----|--------|-----------|--------|
| SELECT | Users can read their own memberships (001) | `user_id = auth.uid()` | ✓ Compliant — each user sees their own rows |
| SELECT | Owners read workspace memberships (010) | `workspaces.owner_id = auth.uid()` | ✓ Added by 010 — required by `/settings/team` |
| INSERT | Owners insert memberships (010) | `workspaces.owner_id = auth.uid()` | ✓ Added by 010 |
| UPDATE | Owners update memberships (010) | `workspaces.owner_id = auth.uid()` | ✓ Added by 010 — role changes |
| DELETE | Owners delete memberships (010) | `workspaces.owner_id = auth.uid()` | ✓ Added by 010 — remove member |

**Acceptance path (non-owner inserts their own row):** uses service-role
through the `/invite/[token]` server action. Service-role bypasses RLS,
which is correct here — the auth boundary is the HMAC signature on the
invitation token, validated server-side.

### `public.workspace_invitations` (new in 010)

| Op | Policy | Condition | Status |
|----|--------|-----------|--------|
| SELECT | Owners read workspace_invitations | `workspaces.owner_id = auth.uid()` | ✓ Compliant |
| INSERT | Owners insert workspace_invitations | `workspaces.owner_id = auth.uid() AND invited_by = auth.uid()` | ✓ Compliant |
| UPDATE | Owners update workspace_invitations | `workspaces.owner_id = auth.uid()` | ✓ Compliant |
| DELETE | Owners delete workspace_invitations | `workspaces.owner_id = auth.uid()` | ✓ Compliant |

**Deliberate non-membership policy.** Invitations are an owner-only
artefact — editors and viewers should not see other people's pending
invites. The invitee themselves consumes the invitation through
service-role on the public `/invite/[token]` page (auth = signed token).

### `public.brand_briefs`

| Op | Policy | Condition | Status |
|----|--------|-----------|--------|
| SELECT | Members can read brand briefs | `is_workspace_member(workspace_id)` | ✓ Compliant |
| ALL | Members can write brand briefs | `is_workspace_member(workspace_id)` | ✓ Compliant |

### `public.social_accounts`

| Op | Policy | Condition | Status |
|----|--------|-----------|--------|
| SELECT | Members can read their accounts | `is_workspace_member(workspace_id)` | ✓ Compliant |
| INSERT | Members can write their accounts | `is_workspace_member(workspace_id)` | ✓ Compliant |
| UPDATE | Members can update their accounts | `is_workspace_member(workspace_id)` | ✓ Compliant |

**Note:** RLS policy allows members to SELECT, but the application
exposes the `social_accounts_safe` view to clients (omits `credentials`).
The credentials column is server-side only (the post-scheduled cron
reads it via service role). No data-leak risk.

### `public.posting_plans`

| Op | Policy | Condition | Status |
|----|--------|-----------|--------|
| SELECT | Members can read plans | `is_workspace_member(workspace_id)` | ✓ Compliant |
| ALL | Members can write plans | `is_workspace_member(workspace_id)` | ✓ Compliant |

### `public.posts`

| Op | Policy | Condition | Status |
|----|--------|-----------|--------|
| SELECT | Members can read posts | `is_workspace_member(workspace_id)` | ✓ Compliant |
| ALL | Members can write posts | `is_workspace_member(workspace_id)` | ✓ Compliant |

### `public.approvals`

| Op | Policy | Condition | Status |
|----|--------|-----------|--------|
| SELECT | Members can read approvals | `exists (posts where id = post_id and is_workspace_member(workspace_id))` | ✓ Compliant |
| INSERT | Members can insert approvals | `user_id = auth.uid() AND exists (posts where id = post_id and is_workspace_member(workspace_id))` | ✓ Compliant — caller can only attribute to themselves |

### `public.post_metrics`

| Op | Policy | Condition | Status |
|----|--------|-----------|--------|
| SELECT | Members can read post metrics | `exists (posts where id = post_id and is_workspace_member(workspace_id))` | ✓ Compliant |
| WRITE | (no public policy) | service-role only | ✓ Compliant — cron is the only writer |

### `public.social_posts_ledger`

No public policy — service-role only. The cron writes idempotency rows;
clients never read this directly. ✓ Compliant.

### `public.events`

| Op | Policy | Condition | Status |
|----|--------|-----------|--------|
| SELECT | Members can read events | `is_workspace_member(workspace_id)` | ✓ Compliant |
| INSERT | (no public policy) | service-role only via `/api/webhooks/[workspace_id]` | ✓ Compliant — HMAC-signed webhook |

### `public.event_rules`

| Op | Policy | Condition | Status |
|----|--------|-----------|--------|
| SELECT | Members can read event rules | `is_workspace_member(workspace_id)` | ✓ Compliant |
| ALL | Members can write event rules | `is_workspace_member(workspace_id)` | ✓ Compliant |

### `public.ai_reviews`

| Op | Policy | Condition | Status |
|----|--------|-----------|--------|
| SELECT | Members can read ai_reviews | `is_workspace_member(workspace_id)` | ✓ Compliant |
| ALL | Members can write ai_reviews | `is_workspace_member(workspace_id)` | ✓ Compliant |

### `public.usage_counters` (005)

| Op | Policy | Condition | Status |
|----|--------|-----------|--------|
| SELECT | Members can read usage counters | `is_workspace_member(workspace_id)` | ✓ Compliant |
| WRITE | (no public policy) | service-role only — billing increment helpers | ✓ Compliant by design |

### `public.playbook_patterns` (008)

| Op | Policy | Condition | Status |
|----|--------|-----------|--------|
| SELECT | Members can read playbook_patterns | `is_workspace_member(workspace_id)` | ✓ Compliant |
| ALL | Members can write playbook_patterns | `is_workspace_member(workspace_id)` | ✓ Compliant |

### Storage — `post-media` bucket (003)

| Op | Policy | Condition | Status |
|----|--------|-----------|--------|
| SELECT/INSERT/UPDATE/DELETE | post-media policies | `is_workspace_member((split_part(name, '/', 1))::uuid)` | ✓ Compliant — workspace-id prefix → membership check |

---

## Summary

- **Tables audited:** 14 (workspaces, memberships, workspace_invitations,
  brand_briefs, social_accounts, posting_plans, posts, approvals,
  post_metrics, social_posts_ledger, events, event_rules, ai_reviews,
  usage_counters, playbook_patterns) + 1 storage bucket (post-media).
- **Compliant tables (before 010):** 12 of 14 (everything except
  workspaces SELECT and memberships write).
- **Issues found:** 2
  1. `workspaces.SELECT` was owner-only — non-owner members could not
     read the workspace row backing their dashboard.
  2. `memberships` had no INSERT/UPDATE/DELETE policy — owners couldn't
     mutate team state for their workspaces.
- **Fixes shipped in 010:**
  1. New permissive `workspaces.SELECT` policy keyed on memberships.
     Original owner-only policy left untouched (additive only, per
     Phase 4 ground rules).
  2. Four owner-keyed policies added to `memberships`
     (read-all / insert / update / delete).

**Net result:** all business-data tables are membership-aware. Editor
and viewer roles now work end-to-end: they can read every business
table they're a member of, write to the tables that members write to,
and are correctly excluded from team management (which is owner-only by
design).

## Future work (not in Phase 4 scope)

- **Editor-write restriction:** at present, both editors and viewers
  fall under "members" — they can both write to brand_briefs, posts,
  plans, etc. If we want viewers to be truly read-only at the DB layer,
  we need a `is_workspace_writer(ws_id)` function that excludes
  `role = 'viewer'` and rewrite the `for all`/insert policies on
  business tables to use it. UI-layer guards aren't enough.
- **Approval attribution:** `approvals.insert` requires `user_id = auth.uid()`
  which is correct, but doesn't verify the user has the writer role.
  Same fix as above would harden this.
- **Stripe/billing tables:** intentionally service-role only. No public
  writes for usage_counters / Stripe-managed columns on workspaces.
