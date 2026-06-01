# Agency / Organization Layer — Design

Status: **Draft for review** · 2026-05-31
Owner: Mohammed · Author: design pass with Claude

Turns the current flat workspace-per-tenant model into a true multi-tenant
agency product: one **organization** (the agency) managing many **client
workspaces**, billed once, with a branded client approval portal.

## Locked decisions
1. **Billing** — the org holds ONE Stripe subscription, priced **per client
   workspace / seat**. Client workspaces are free sub-tenants that inherit
   entitlements from the org plan.
2. **Social connection** — the agency connects client Pages by being an
   admin/editor on them via **Meta Business Manager**; one agency OAuth yields
   many Page tokens, and a **Page picker** maps each Page to a client workspace.
3. **Client portal** (`/client/[token]`) — clients **approve/reject drafts**
   and **view reports**. Tokenized, no client login.
4. **White-label** — **logo + colors per org**, applied to the portal and
   report PDFs. No custom domains in v1.

## Current state (V1 tenancy) — what we build on
- `workspaces` = tenant; has `owner_id`, `plan` (hobby/pro/agency), and its own
  Stripe customer/subscription (`migrations/005`).
- `memberships` (owner/editor/viewer) + `workspace_invitations` (`migrations/010`).
- `is_workspace_member(ws_id)` gates every tenant table's RLS (`migrations/001`).
- Active workspace via `mm_active_ws` cookie (`lib/workspace.ts`).
- Social tokens stored per-workspace on `social_accounts`; FB connect currently
  auto-picks the first publishable Page (`lib/social/facebook.ts:118-120`).

Additive design: everything below is backward-compatible. A workspace with
`organization_id = null` behaves exactly as today (solo users unaffected).

## Data model (new)
```
organizations
  id, slug, name, owner_id (agency owner),
  branding: logo_url, color_primary, color_accent,
  stripe_customer_id, stripe_subscription_id, subscription_status,
  plan/tier, created_at, updated_at

org_memberships
  (organization_id, user_id, role in ('admin','manager')) PK

workspaces
  + organization_id uuid null references organizations(id)   -- client workspace when set

client_portal_tokens
  id, workspace_id, token_hash, label (client contact),
  scopes text[] (e.g. {'approve','view_reports'}),
  expires_at, revoked_at, created_by, created_at
```

## RLS changes (highest-risk area)
Extend the one helper everything already depends on:
```sql
-- is_workspace_member(ws_id): existing owner/membership checks, PLUS:
or exists (
  select 1 from public.workspaces w
  join public.org_memberships om on om.organization_id = w.organization_id
  where w.id = ws_id and om.user_id = auth.uid()
)
```
Because every tenant table routes through this function, the agency-staff
cross-workspace grant lands everywhere from one change. **Requires a dedicated
RLS test pass** to prove no cross-org leakage.

`organizations` / `org_memberships`: members read; owner updates/manages.

**Client portal** is tokenized (not `auth.uid()`): reads/writes go through the
service role with the token resolved to exactly one `workspace_id`. This path
bypasses RLS, so it needs a hardened, single data-access module that scopes
*every* query to the token's workspace — this is the #1 security surface.

## Billing — org pays once, per-client/seat
- Move the subscription to the org: one Stripe subscription with
  **quantity = number of active client workspaces** (or seats).
- Add/remove a client → adjust subscription quantity (proration handled by Stripe).
- **Entitlement resolver**: `assertWithin*Quota` resolves limits via the org
  when `workspace.organization_id` is set; falls back to `workspace.plan`
  otherwise (solo path unchanged).
- Webhook: add org-tier price IDs to the existing
  `planForPriceId`/webhook handler; set `organizations.subscription_status`.
  (See [[stripe-webhook-silent-failure-debug]] — same loud-logging pattern.)

## Agency social connection + Page picker
- Precondition: agency is admin/editor on the client's Page in Meta Business
  Manager → client Pages appear in the agency's `/me/accounts`.
- Build the **Page picker** (mirror `settings/channels/linkedin/select-target`):
  after OAuth, list all returned Pages by name; operator picks which Page maps
  to the current client workspace; store that Page's token on the workspace's
  `social_accounts`. Replaces the auto-first-Page logic.
- IG/Threads analogous (IG Business account linked to the chosen Page).
- **Note:** the org layer does NOT remove the **Meta App Review / Advanced
  Access** dependency — onboarding non-tester client accounts at scale still
  needs it. See [[meta-app-review-strategy]].

## Client portal (`/client/[token]`)
- Magic-link token → workspace + scopes; short expiry + revocation.
- **Approve/reject**: render the workspace's `pending_approval` posts; reuse the
  approve/reject logic via token-authenticated server actions. `approvals`
  needs an audit tweak — record the portal token id (make `user_id` nullable +
  add `client_token_id`, or a "via_portal" marker) since there's no auth user.
- **Reports**: read-only scheduled/published posts + `post_metrics`.
- Renders org white-label branding; feeds the client **report PDF**.

## White-label (logo + colors per org)
- `organizations.branding` (logo in Supabase storage, two colors).
- Applied to: client portal, report PDFs, optionally client emails.
- Org-owner settings UI to upload logo + pick colors.

## Onboarding — "add a client"
Org admin → Add client → create workspace with `organization_id` set → optional
client portal token + email invite → bump Stripe subscription quantity.

## Sequencing
- **Phase A — Foundations:** `organizations`, `org_memberships`,
  `workspaces.organization_id`, RLS extension + test pass, create-org / add-client,
  workspace switcher shows org clients. *Unblocks agency staff managing many
  client workspaces.*
- **Phase B — Page picker:** client Page connection via Business Manager.
  Independent of A; also benefits solo users with multiple Pages.
- **Phase C — Org billing:** Stripe org subscription + quantity sync +
  entitlement resolver + webhook. Depends on A.
- **Phase D — Client portal:** tokenized approve/reject + reports, white-labeled,
  with report PDF. Depends on A (+ approval reuse).
- **Phase E — White-label polish + org settings UI.**

## Risks
1. **Portal security** (tokenized, RLS-bypassing) — hardened scoped DAL, scopes,
   expiry, revocation; the highest-risk surface.
2. **RLS blast radius** — `is_workspace_member` touches everything; prove no
   cross-org leak with explicit tests.
3. **Meta App Review** still gates real client onboarding (orthogonal but blocking).
4. **Stripe quantity sync / proration** correctness on add/remove client.
