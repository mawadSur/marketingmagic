# Production-readiness checklist — marketingmagic

Assessment date: 2026-06-09. Status legend: ✅ done · ⚠️ partial/gap · ❌ missing · 🔒 external (not code).

The app is in good shape for a soft launch (CI, tests, error boundaries, signed
auth, legal pages, no hardcoded secrets). The list below is what stands between
"works for us + early users" and "I'd trust this with paying strangers at scale."

---

## P0 — do before real paying customers

1. **❌ Error monitoring / alerting.** No Sentry/Datadog/Rollbar anywhere. Today a
   500 in production is invisible unless someone reports it (that's how the
   handle-finder + IG bugs surfaced — by eye). **Add Sentry** (server + client +
   source maps), wire `global-error.tsx` / `(app)/error.tsx` to report, and set
   an alert on error-rate. Single highest-leverage item.

2. **⚠️ Stripe webhook dedupe is in-memory (`seenEventIds` Set).** Survives
   re-delivery only within one warm instance; a cold start or second lambda
   re-processes an event. Settings are idempotent so blast radius is small, but
   move the dedupe to a durable store (a `stripe_events` table, INSERT-on-id) so
   it's correct across instances.

3. **❌ No rate limiting on expensive/abusable routes.** The AI endpoints
   (handle-finder, /start preview, plan generation) and the OAuth initiates have
   no per-user/IP throttle. A scripted abuser can run up the Anthropic bill or
   trip platform rate-limits. Add Upstash Ratelimit (or a simple per-workspace
   token bucket) on the AI + probe + auth-initiate routes.

4. **🔒 External platform approvals (blocks real multi-channel use).**
   - **YouTube** OAuth verification — blocked on the *.vercel.app domain; needs the
     surconsultinggroup.com subdomain cutover (waiting on the GoDaddy A record).
     See [[youtube-oauth-verification-blocked]].
   - **LinkedIn** + **TikTok** still `comingSoon: true` (awaiting CMA review / app
     audit) — connect is disabled.
   - **Facebook** showing Meta's "Feature unavailable" (App Review / Dev-mode /
     Business Verification state). See docs/TODO.md #5.
   - **Meta App Review** for IG/Threads publish permissions before non-test users.

5. **⚠️ Custom domain.** Running on `marketingmagic.vercel.app`. Needed for the
   YouTube fix AND for brand/email trust. Move to the owned domain + set
   `NEXT_PUBLIC_SITE_URL` + re-point all OAuth redirect URIs.

---

## P1 — hardening (soon after launch)

6. **⚠️ OAuth CSRF is cookie-fragile on the other channels.** Instagram was fixed
   (signed state, commit 239bb6f). x / threads / linkedin / facebook still gate
   their callbacks on the `*_oauth_nonce` cookie alone → same latent "can't
   connect on mobile" bug. Migrate all four to `signOAuthState`/`verifyOAuthState`
   (the helper already exists in src/lib/social/oauth-state.ts).

7. **❌ Security headers / CSP.** No Content-Security-Policy, HSTS, X-Frame-Options,
   or X-Content-Type-Options. Add them in `next.config` headers() or middleware.
   (Vercel sets some defaults, but no CSP = XSS exposure on a content app.)

8. **❌ Health check endpoint.** No `/api/health`. Add one (DB ping + critical env
   presence) for uptime monitoring (and so a deploy that loses Supabase creds is
   caught by a monitor, not a user).

9. **⚠️ Secret rotation / least-privilege.** `SUPABASE_SERVICE_ROLE_KEY` is used in
   many server paths (correct), but there's no documented rotation procedure and
   no separation between read vs write service roles. Document a rotation runbook.

10. **⚠️ Log hygiene.** ~90 `console.*` calls in src. Confirm none log secrets,
    tokens, or PII (the OAuth + BYO-key + interactions paths are the risk). Route
    intentional ones through a logger that scrubs; drop the rest.

11. **⚠️ Email deliverability.** Resend is wired with graceful-degrade (good), but
    verify: production `RESEND_API_KEY` set, `EMAIL_FROM` on a verified domain
    with SPF/DKIM/DMARC, and that transactional mail (digests, invites) actually
    lands (not spam). Tie to the custom-domain move.

---

## P2 — quality / scale

12. **⚠️ Background-job durability.** 13 crons run via GitHub Actions + CRON_SECRET
    (all authed ✅). No ret/dead-letter or alert if a cron *fails* — a silently
    broken pull-metrics or poll-interactions just stops. Add failure alerting
    (ties to #1) and consider moving the hot ones to a real queue if volume grows.

13. **⚠️ DB indexes + N+1 review under load.** Fine at current scale; before real
    traffic, review the hot read paths (queue, dashboard, inbox) for missing
    composite indexes and per-row fan-out.

14. **⚠️ 25 TODO/FIXME markers in src.** Triage — most are "deferred slice" notes
    (organic video byte-source, grouped-batch variations view) but confirm none
    are correctness gaps.

15. **⚠️ E2E coverage of the money paths.** 13 e2e specs exist (channels, video).
    Add explicit e2e for: signup → onboarding → connect → first post, and the
    Stripe checkout → entitlement-unlock round-trip (the paywall logic shipped
    recently; it deserves a live-path test).

16. **❌ Accessibility + perf audit.** No Lighthouse/axe gate. The landing + app
    shell should pass WCAG AA contrast + keyboard nav (gstack /qa + /design-review
    can do this). Add a Lighthouse budget to CI.

17. **⚠️ Backup / disaster recovery.** Confirm Supabase PITR (point-in-time
    recovery) is enabled on the prod project and document the restore procedure.

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
