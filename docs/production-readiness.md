# Production-readiness checklist — marketingmagic

Assessment date: 2026-06-09. Reconciled after two agent fan-outs (same day).
Status legend: ✅ done · ⚠️ partial/gap · ❌ missing · 🔒 external (operator/not code).

The CODE-SIDE list is now essentially complete. What remains is **operator/external**
work (consoles, DNS, env vars) that agents can't do — collected at the bottom under
"🔒 Operator action required".

---

## P0 — do before real paying customers

1. **✅ DONE — Error monitoring.** Sentry (@sentry/nextjs) wired server+client+edge,
   global-error.tsx / (app)/error.tsx report, and all 13 cron routes call
   captureException on failure. Graceful no-op until the DSN env is set (operator
   action below). Commits 52f2f6f + c2ad706.

2. **✅ DONE — Durable Stripe dedupe.** Migration 064 `stripe_events` ledger; the
   webhook INSERTs the event id and rolls it back on handler failure so a
   transient error never silently drops a billing event. Commit f61f616 + dd16a32.

3. **✅ DONE — Rate limiting.** src/lib/rate-limit.ts (Upstash, graceful no-op when
   unconfigured) applied to handle-finder, /start preview, plan generation, and all
   7 OAuth initiate routes. Activates once the Upstash env is set (operator below).
   Commits 52f2f6f + 0365b29.

4. **🔒 External platform approvals** — operator-only (see bottom).

5. **🔒 Custom domain** — operator-only (see bottom).

---

## P1 — hardening (soon after launch)

6. **✅ DONE — OAuth CSRF mobile-robust on ALL channels.** Instagram (239bb6f) +
   X / Threads / LinkedIn / Facebook (1962a81) now verify a signed `state` instead
   of depending on a cookie mobile drops. X keeps its PKCE verifier cookie (PKCE
   requires it). YouTube/TikTok initiates also rate-limited.

7. **✅ DONE — Security headers / CSP.** next.config headers(): HSTS, X-Content-Type-
   Options, X-Frame-Options, Referrer-Policy + a **report-only CSP**. Flip to
   enforce after a clean week (operator below). Commit 52f2f6f.

8. **✅ DONE — Health check.** `/api/health` (Supabase ping + critical-env presence),
   200/503. Commit 52f2f6f.

9. **✅ DONE (documented) — Secret rotation runbook.** docs/secret-rotation-runbook.md.

10. **✅ DONE — Log hygiene.** Audited (docs/log-hygiene-report.md); 0 HIGH, 3 MEDIUM
    PII lines redacted (data-deletion FB uid, IG verify ids). Commit dd16a32.

11. **🔒 Email deliverability** — code is wired (Resend, graceful-degrade); verifying
    the sending DOMAIN's SPF/DKIM/DMARC is operator work (see bottom).

---

## P2 — quality / scale

12. **✅ DONE — Cron failure alerting.** All 13 cron routes capture to Sentry on
    failure (tags: cron name + internal id). A silently-broken cron now surfaces.

13. **✅ DONE — DB index review.** Migration 065 adds the one genuinely-missing hot-path
    index: posts(workspace_id, status, scheduled_at) for /queue. Inbox/dashboard
    already covered — no gratuitous indexes added (docs/db-index-review.md). Commit aaed1c5.

14. **✅ DONE — TODO triage.** docs/todo-triage.md: all 25 markers are deferred-feature,
    0 correctness gaps.

15. **✅ DONE — Money-path tests.** +25 unit/integration tests for the paywall +
    account-entitlement paths (the recently-shipped billing logic). Full live-browser
    e2e of signup→post is still a nice-to-have but the logic is covered.

16. **✅ DONE (advisory) — Lighthouse/a11y CI.** .github/workflows/lighthouse.yml +
    lighthouserc.json run against the public pages, NON-BLOCKING (warn) for now —
    tighten to enforce later. Commit aaed1c5.

17. **🔒 Backup / DR** — confirm Supabase PITR in the dashboard (operator below).

---

## 🔒 Operator action required (NOT code — the only things left)

**A. Env vars to ACTIVATE the shipped features** (all graceful-degrade; app runs without them):
- `SENTRY_DSN` + `NEXT_PUBLIC_SENTRY_DSN` — turn on error monitoring. (`SENTRY_AUTH_TOKEN` optional, for source-map upload at build.)
- `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` — turn on rate limiting.
- `RESEND_API_KEY` + `EMAIL_FROM` — confirm set in prod for transactional email.

**B. Custom domain** — add the GoDaddy A record `marketingmagic.surconsultinggroup.com → 76.76.21.21`; then re-point `NEXT_PUBLIC_SITE_URL` + the OAuth redirect URIs. Unblocks YouTube verification + email trust.

**C. Platform approvals** — YouTube OAuth verification (needs the domain), LinkedIn CMA review, TikTok app audit, Meta App Review for IG/Threads, and resolve the Facebook "Feature unavailable" app-status (docs/TODO.md #5).

**D. Email DNS** — SPF / DKIM / DMARC on the sending domain (tie to B).

**E. Supabase PITR** — confirm point-in-time-recovery is enabled on the prod project; document the restore steps.

**F. CSP enforce** — after ~1 week of clean report-only CSP, rename the header from `Content-Security-Policy-Report-Only` to `Content-Security-Policy` in next.config (one-line change; can be a tiny PR).

---

## Already solid ✅ (no action)

- CI runs typecheck + production build + full Vitest on every push/PR.
- 70 unit/integration test files + 13 e2e specs; 749 tests passing.
- Error boundaries: global-error.tsx, (app)/error.tsx, not-found.tsx.
- Legal: /privacy, /terms, /data-deletion present.
- Stripe webhook verifies signatures (constructEvent) + dedupes on event.id.
- All 13 cron routes authed via CRON_SECRET.
- No hardcoded secrets in src; env shape-validated via zod (serverEnv).
- Account-level billing entitlements + workspace-creation paywall enforced
  server-side (not just UI).
- Migrations at local==remote parity (through 063).
