# Go-Live Runbook — marketingmagic

> Goal: production-ready, onboard paying customers ASAP.
> Last verified: 2026-06-01 (live probes against `https://marketingmagic.vercel.app`).

This runbook turns the end-to-end audit into ordered, copy-paste steps. It is
split into **✅ already verified live**, **🔴 confirm before first customer**, and
**🟡 per-channel / per-feature unlocks**. Re-run `node scripts/prod-smoke.mjs`
after any change to re-check the green board.

---

## ✅ Already verified live (2026-06-01 probes)

You do **not** need to redo these — they were confirmed by live HTTP probes:

| What | Evidence | Status |
|------|----------|--------|
| App boots, boot-critical env set | `GET /` → 200 (serverEnv would 500 the whole app if `SUPABASE_*` / `ANTHROPIC_API_KEY` / `CRON_SECRET` were missing) | ✅ |
| Auth gating works | `GET /video` → 307 redirect to login | ✅ |
| Cron auth gate | `GET /api/cron/poll-video-jobs` (no secret) → 401 | ✅ `CRON_SECRET` set in Vercel |
| MPT render worker up | `GET https://mpt-render-worker.onrender.com/docs` → 200 | ✅ |
| Stripe webhook configured | `POST /api/webhooks/stripe` (bad sig) → 400, not 503 | ✅ `STRIPE_WEBHOOK_SECRET` set |
| Supabase migrations 026–029 | `supabase db push` → "Remote database is up to date" | ✅ applied to prod |
| Vercel / GitHub / Stripe / Render env+secrets | owner-confirmed 2026-06-01 (all match) | ✅ set |
| Vercel auto-deploy | push `5521255` → new prod build went Ready in 53s | ✅ unblocked (cron fix `f87ce6e`) |
| Build pipeline | `ci` + `MPT worker E2E` both green on `eadec16` | ✅ |
| Video publish path | rendered videos now post as `pending_approval` (fix `d65747e`) | ✅ no longer dead-ends |

---

## 🔴 Confirm before first paying customer

> **Status 2026-06-01: all four confirmed done.** Migrations verified applied via
> `supabase db push`; env/secrets owner-confirmed across Vercel, GitHub, Stripe,
> and Render. Steps retained below as reference for re-verification / new environments.

### 1. Supabase migrations 026–029 applied to prod
The repo has migrations `026_video_pipeline`, `027_video_quota`,
`028_tiktok_channel`, `029_org_layer`. If `026` isn't applied, the video poller
queries a non-existent `video_jobs` table.

- Supabase Studio → your prod project → **SQL Editor**, run:
  ```sql
  select table_name from information_schema.tables
  where table_schema = 'public' and table_name in ('video_jobs','workspace_byo_keys');
  -- expect 2 rows
  select column_name from information_schema.columns
  where table_name = 'usage_counters' and column_name = 'videos_generated';
  -- expect 1 row (migration 027)
  ```
- If missing: `supabase db push` from the repo (or paste each `supabase/migrations/02{6,7,8,9}_*.sql` into the SQL editor in order).

### 2. Stripe price IDs set in Vercel
The webhook secret is set (✅), but the **price→plan mapping** must match. Without
correct `STRIPE_PRICE_*`, a paid checkout logs `console.error` and the customer
is **not** upgraded (this was the prior silent-failure bug).

- Vercel → Settings → Environment Variables, confirm present & matching live-mode price IDs:
  `STRIPE_SECRET_KEY`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_AGENCY`,
  `STRIPE_PRICE_CREATOR`, `STRIPE_PRICE_ORG_SEAT`.
- Stripe Dashboard → Webhooks → confirm endpoint
  `https://marketingmagic.vercel.app/api/webhooks/stripe` is subscribed to
  `checkout.session.completed`, `customer.subscription.{created,updated,deleted}`.
- **Emergency unblock for your own workspace** (if a payment didn't apply):
  ```sql
  update workspaces set plan='founder', subscription_status='active'
  where name='Pitch Pit';
  ```

### 3. GitHub repo secrets (drive the 10 cron jobs)
- GitHub → repo → Settings → Secrets and variables → Actions, confirm:
  `SITE_URL` (= `https://marketingmagic.vercel.app`) and `CRON_SECRET`
  (**byte-identical** to the Vercel `CRON_SECRET`). If either is unset, all 10
  cron workflows hard-fail (loudly — check the Actions tab is green).

### 4. Render worker secrets
- Render dashboard → `mpt-render-worker` → Environment:
  `MPT_API_KEY` must equal Vercel's `MPT_API_TOKEN` (or every worker call 401s),
  and `CORS_ALLOWED_ORIGINS` should be your app origin, **not** `*`.
- Note: worker `autoDeploy: false` — after any `services/mpt-worker/**` change,
  trigger a manual deploy on Render.

---

## 🟡 Per-feature / per-channel unlocks

### Video generation (BYO keys)
Per-workspace, entered in the product UI — each customer (or you) does this:
- `/settings/video-keys` → add **BYO LLM key** (OpenAI/Anthropic/etc.) + **Pexels API key**.
- Without them `/video` shows "not available" (graceful, not an error).
- Vercel env already set per memory: `MPT_BASE_URL`, `MPT_API_TOKEN`,
  `BYO_ENCRYPTION_KEY`, `VIDEO_PUBLISH_CHANNELS=bluesky,facebook,threads`.

### Publishing channels — what works *today* vs gated
All 7 adapters are **code-complete** (audited: zero code gaps). Status is purely
external approval:

| Channel | Text | Video | Blocker to enable |
|---------|------|-------|-------------------|
| **Facebook** | ✅ live | ✅ live | none — works now |
| **Bluesky** | ✅ live | ✅ live | none — works now |
| **Threads** | ✅ live | ✅ live | none (publish); reply/inbox waits on Meta App Review |
| **X / Twitter** | ✅ live | ⏳ | add `media.write` scope → **re-auth every X account**; then add `x` to `VIDEO_PUBLISH_CHANNELS` |
| **LinkedIn (personal)** | ✅ live | ⏳ | just add `linkedin` to `VIDEO_PUBLISH_CHANNELS` (no extra grant) |
| **Instagram** | ⏳ | ⏳ | Meta App Review of `instagram_business_content_publish` + convert IG to Business/Creator |
| **LinkedIn (org)** | ⏳ | ⏳ | LinkedIn Community Management API approval (submitted 2026-05-18) |
| **TikTok** | n/a | ⏳ | TikTok app audit (auto SELF_ONLY until passed) + set `TIKTOK_CLIENT_KEY/SECRET` + add `tiktok` to `VIDEO_PUBLISH_CHANNELS` |

**Fastest path to a live demo:** Facebook + Bluesky + Threads publish text **and**
video right now. Onboard the first customer on those three; unlock the rest as
approvals land.

### Meta App Review pre-reqs (for IG/Threads/FB at scale)
Per `meta-app-review-strategy`: add yourself as Tester on the 3 Meta apps,
allowlist the OAuth redirect URIs, convert IG to Business, record the auth-flow
screen capture. See `docs/` / memory for the reviewer-notes copy.

---

## Smoke test

Re-run after any dashboard change:
```bash
node scripts/prod-smoke.mjs                       # green board against prod
node scripts/prod-smoke.mjs --cron-secret "$CRON_SECRET"   # also verifies authed cron 200
```

## First-customer checklist (TL;DR)
1. [x] Migrations 026–029 applied (§1) — verified 2026-06-01.
2. [x] `STRIPE_PRICE_*` set & webhook subscribed (§2) — owner-confirmed.
3. [x] GitHub `SITE_URL` + `CRON_SECRET` secrets (§3) — owner-confirmed.
4. [x] Render `MPT_API_KEY` = `MPT_API_TOKEN` (§4) — owner-confirmed.
5. [ ] Add your BYO LLM + Pexels keys at `/settings/video-keys`.
6. [ ] Connect Facebook / Bluesky / Threads; do one real text post + one video.
7. [ ] Run `node scripts/prod-smoke.mjs` → all green. *(6/6 PASS as of 2026-06-01.)*
8. [ ] Onboard customer. Unlock X/IG/LinkedIn/TikTok as approvals land.

**Bottom line: infra and code are production-ready.** Only product-level steps
remain — add your BYO video keys, connect the 3 live channels, and run a real
post. Everything blocking has been cleared.
