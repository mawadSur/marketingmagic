# marketingmagic — plan

> A multi-tenant marketing automation tool that auto-generates posting plans and ships posts on a hybrid (approve-then-trust) flow. Built personal-first (dogfood on pitch-pit + my own projects), SaaS-second (onboard external clients later).

## North star

**Auto-generated posting plans + automatic posting + high-quality, brand-faithful content + data-driven iteration.**

In one sentence: feed it your product brief, it produces a 4-week posting calendar, you approve drafts, it posts on schedule, it pulls back KPIs, it learns which themes win, it generates the next plan with the winners weighted higher.

The wedge is *plan generation*, not just scheduled posting. Buffer/Hypefury schedule what you write. We write what you'd schedule, ranked by what's working.

---

## The angle (what makes this not just another Buffer)

1. **Plans, not just posts.** Output is a calendar with themes, not a stream of disconnected drafts.
2. **Brand voice fidelity.** Per-workspace style guide + reference posts → drafts that don't sound generic.
3. **Event-driven content.** Webhook ingestion means database events from your products *become* posts (we already proved this in pitch-pit).
4. **Data-driven iteration.** Pull metrics back, identify highest-ROI themes, weight the next plan generation toward them.
5. **Hybrid approval.** Manual approval until trust threshold, then auto-post (with a 24h preview window for revoke).

If we're not measurably better on at least 2 of these vs. Hypefury/Postiz, we don't have a product.

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js 16 + App Router | Match pitch-pit; lift `lib/social/x.ts` directly |
| DB + Auth | Supabase (Postgres + RLS) | Multi-tenancy via row-level security; auth out of the box |
| LLM | Claude Sonnet 4.6 (`@anthropic-ai/sdk`) | Best long-form brand voice fidelity in our hands |
| UI | TailwindCSS + shadcn/ui | Dashboard primitives without custom design work |
| Hosting | Vercel | Cron + edge runtime |
| Cron | Vercel Cron (time-based) + Supabase webhooks (event-based) | Same dual pattern as pitch-pit |
| Email | Resend (later, for digests + alerts) | Cheap, dev-friendly |
| Billing (V2) | Stripe | Standard |

**Lift from pitch-pit:** `lib/social/x.ts` (OAuth 1.0a + post helper), `lib/slug.ts` (URL slugging), the cron auth pattern, the `social_posts` idempotency table concept. Copy not share — these will diverge.

---

## Multi-tenancy

Row-level isolation with RLS, not schema-per-tenant.

**Vocabulary:**
- `workspace` = a tenant. In your language: a "client." For V0, you're the only owner with one workspace ("pitchpit").
- `membership` (V1+) = user × workspace, with a role (owner / editor / viewer).
- `social_account` = one channel connection within a workspace (one X handle, one IG account, etc.).

Every business-data table has a `workspace_id` FK and an RLS policy that checks `auth.uid()` is a member of that workspace. Service-role (cron + webhooks) bypasses RLS.

---

## Data model (V0 → V1)

See `supabase/migrations/001_init.sql` for canonical SQL. Conceptual map:

```
workspaces (= clients)
  ├── memberships (V1; for V0 use workspaces.owner_id)
  ├── brand_briefs               # product, voice, audience, do-not-say
  ├── social_accounts            # connected channels with credentials
  ├── posting_plans              # generated 4-week calendars
  │     └── posts                # individual drafts/scheduled/sent
  │           ├── approvals      # audit trail of approve/edit/reject
  │           └── post_metrics   # impressions, clicks, engagement (V1)
  ├── events (V1)                # ingested webhook events
  ├── event_rules (V1)           # event_type → post template
  └── automations (V1)           # cron-like rules per workspace
```

**Why this shape:**
- `posting_plans` separate from `posts` so we can regenerate plans without losing post history.
- `posts.theme` is a tag (e.g., `"winner-announcement"`, `"build-progress"`, `"voice-thought-piece"`) — analytics aggregate by theme so we know which categories perform.
- `post_metrics` is a separate table (1:N) so we can re-fetch over time and see decay.
- `social_accounts.trust_mode` + `successful_post_count` drive the hybrid approval state machine.

---

## Hybrid approval state machine

```
draft → pending_approval → approved → scheduled → posted
                       ↘ rejected
                       ↘ edited (user) → pending_approval (again)
```

Per `social_account`:
- Default: `trust_mode = false`. Every draft requires explicit approval.
- After **5 consecutive approved+posted+no-edit-after-post** posts, prompt the user: *"trust this channel to auto-schedule new drafts? you can revoke any time."*
- If user opts in: `trust_mode = true`. New drafts go straight to `scheduled` with a 24h preview window — the dashboard shows them as "posting in Xh, click to revoke."
- One bad post (user clicks "should not have posted") drops `trust_mode = false` and resets `successful_post_count`.

Trust is per-channel, not per-workspace. You may trust the X channel auto-posting but require manual approval on LinkedIn.

---

## Channel rollout order (locked in)

1. **X / Twitter** — V0. OAuth 1.0a posting (lifted from pitch-pit). Free tier: 1.5k posts/month. Metrics via X API v2.
2. **Instagram + Facebook** — V1.5. Meta Graph API. Business accounts only. Reels uploads are flaky — caption + image first, video later.
3. **Threads + Bluesky** — V2. Threads via Meta Graph API. Bluesky via ATproto `createRecord` (no OAuth dance).
4. **LinkedIn** — V3. LinkedIn Marketing API is gated; partner approval can take weeks. Park until earlier channels prove ROI.

---

## Plan generation (how Claude produces a calendar)

**Input:**
- Brand brief: product description, voice, target audience, do-not-say list, reference posts
- Channel mix: ["x"] for V0, more later
- Cadence: posts per week per channel
- Optional: recent KPIs (which themes won last month)

**Prompt structure (Claude Sonnet 4.6):**
- System: brand brief + voice rules + channel constraints (char limits, tone-per-channel)
- System: cache_control ephemeral (will become free as it grows)
- User: "Generate a 4-week posting plan with N posts per week. For each post produce: text, channel, theme, suggested_scheduled_at, rationale."

**Output:** structured JSON, validated by zod. Drafts inserted into `posts` with `status = 'pending_approval'` linked to a new `posting_plans` row.

**Iteration loop:** when generating plan N+1, include "themes that performed in top 25%" and "themes that performed in bottom 25%" from the previous plan's `post_metrics`. The model weights toward winners.

---

## Event-driven posts

Same pattern as pitch-pit but generalized:

1. External system (your product) hits `POST /api/webhooks/[workspace_id]` with `{ event_type, payload, signature }`.
2. We verify the signature against the workspace's webhook secret.
3. Insert into `events`. Look up matching `event_rules`.
4. For each rule, render the template against the payload, queue a post draft (or auto-schedule if trusted).
5. Same approval flow as plan-generated posts.

Example rule: `event_type = "new_winner"` → template `"this week's winner: {{title}} — {{score}}/100. building it now → {{url}}"` for `channels = ["x"]`.

This is the magic that lets pitch-pit's existing webhooks just *work* with marketingmagic.

---

## KPIs + dashboard

**V0 metrics (pulled from X API):**
- Posts shipped (count, by status, by channel, by theme)
- Impressions per post
- Engagement: likes, reposts, replies, clicks
- CTR (clicks / impressions)
- Best-performing themes (rank by engagement rate, week-over-week trend)

**V1 metrics (cross-channel):**
- Per-workspace dashboard: posts shipped this week, % approved without edits, time-to-approval, top theme
- Per-channel breakdown
- Plan-level rollup (how did this 4-week plan perform vs. last)

**Dashboard layout (V1):**
- Top: 4 KPI cards (posts shipped, approval rate, total impressions, top theme)
- Mid: posting calendar view (next 14 days) with status pills
- Bottom: theme leaderboard (engagement rate by theme)
- Side: pending approvals queue

---

## Scope boundaries

### V0 — this week, single tenant (you), X-only, manual approval

- Auth + single workspace creation
- Brand brief CRUD
- Connect X account (manual paste of OAuth 1.0a creds — not a flow yet)
- Generate posting plan (Claude → 7 drafts for 1 week, JSON-validated)
- Approval queue UI (table view: approve / edit / reject)
- Cron that posts approved scheduled items (Vercel Cron every 5 min)
- Idempotency ledger (lifted from pitch-pit's `social_posts` table)

**Not in V0:** dashboard KPIs, metrics pull-back, multi-workspace, event ingestion, trust mode, OAuth signup flow, IG/FB/etc.

### V1 — week 2, dogfooding hardens

- Metrics pull from X API → `post_metrics` rolled-up
- Dashboard with KPI cards + calendar view + theme leaderboard
- Event ingestion (`/api/webhooks/[workspace_id]`)
- Hybrid trust mode state machine
- Multi-workspace (you have N projects)
- Plan regeneration with KPI-weighted prompt

### V1.5 — month 2, real second tenant

- OAuth 3-legged flow for X (so a client can self-connect)
- Memberships (multi-user per workspace)
- Email digests (weekly performance email)
- Better post editor (with media attach, character count, preview)

### V2 — month 3+, expand

- Instagram + Facebook (Meta Graph API)
- Threads (Meta) + Bluesky (ATproto)
- Stripe billing
- Rate limiting + per-tier quotas

### V3

- LinkedIn (after partner approval lands)
- Voice cloning (fine-tune a per-workspace style)
- Multi-language

---

## Build sequence (V0)

In order, sized:

1. **Repo scaffold** — `create-next-app`, Tailwind, shadcn/ui init, Supabase client setup, env example. *1 hour.*
2. **Schema migration** (already drafted in `supabase/migrations/001_init.sql`) + push to Supabase project. *30 min.*
3. **Auth pages** — `/login`, `/signup` via Supabase Auth UI. *1 hour.*
4. **Workspace creation flow** — first-time onboarding creates `workspaces` row + redirects to `/dashboard`. *1 hour.*
5. **Brand brief form** — `/settings/brief`, server action persists to `brand_briefs`. *1 hour.*
6. **Connect X (manual paste flow)** — `/settings/channels/x`, encrypts and stores creds in `social_accounts`. *1 hour.*
7. **Plan generator** — server action that prompts Claude with brief + brief, validates JSON, inserts posts. UI at `/plans/new`. *3 hours.*
8. **Approval queue UI** — `/queue`, list of `pending_approval` posts, approve/edit/reject buttons. *2 hours.*
9. **Posting cron** — `/api/cron/post-scheduled` runs every 5 min, picks up `status='scheduled' AND scheduled_at < now()` posts, ships them via lifted X helper, updates status. *2 hours.*
10. **Idempotency + audit log** — `social_posts` ledger, `approvals` audit trail. *1 hour.*

Total V0: ~13–15 hours of focused work. Two long sessions or a weekend.

---

## Open questions (to settle before V1)

- Do we encrypt `social_accounts.credentials` at rest with a separate KMS key, or rely on Supabase's at-rest encryption + service-role-only access? (Probably the latter for V0; KMS for V2.)
- How long do we retain `events.payload` data? (Default: 90 days, configurable per workspace.)
- Plan regeneration cadence: user-triggered, weekly, or monthly? (Default: weekly auto-draft, user approves the plan as a whole or post-by-post.)
- A/B testing inside a plan? (Not V0. Maybe V2 once we have enough data per theme.)
- Do drafts ever go stale? (Yes — drafts older than 14 days that haven't been approved should auto-archive.)
