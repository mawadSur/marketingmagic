# Log Hygiene Report

## Overview

This report audits all `console.*` calls in `src/` for potential secret/token/PII leakage. Logs are visible in Vercel function logs, which are retained per the configured window. Any sensitive data logged could be exposed to operators with log access or leaked via log aggregation tools.

**Total console.* calls found:** 90

**HIGH-risk findings:** 0 (no confirmed secret/token leaks)
**MEDIUM-risk findings:** 3 (PII or sensitive IDs)
**LOW-risk findings:** 87 (safe error/warning logs)

---

## HIGH-Risk Logs (Secret/Token Leakage)

**None found.** No console.* calls directly log secrets, tokens, or credentials.

**Note:** The codebase correctly avoids logging:
- OAuth access tokens (never logged in token exchange paths)
- API keys (BYO keys in `src/lib/video/byo-keys.ts` stay in-memory only)
- Stripe webhook signatures (raw body never logged)
- Password fields (auth flows use Supabase SDK, no plaintext logs)

---

## MEDIUM-Risk Logs (PII / Sensitive IDs)

### 1. Facebook Data Deletion Callback

**File:line:** `src/app/api/data-deletion/route.ts:132`

**What it logs:**
```typescript
console.log("[data-deletion] received", {
  user_id: payload.user_id,
  issued_at: payload.issued_at,
  expires: payload.expires,
  code,
});
```

**Risk:** MEDIUM — logs Facebook `user_id` (PII under GDPR/CCPA if tied to other identifiers) and the signed deletion payload. The `user_id` is Meta's internal identifier for the user who removed the app.

**Recommended action:**
- Redact or hash `user_id` before logging: `user_id: hashUserId(payload.user_id)`.
- OR: move this log to a separate audit trail table (not function logs) so it's queryable but not exposed in Vercel logs.
- Justification for keeping: needed for manual cleanup auditing (see the comment — FB user_id doesn't directly match our IG/Threads credentials, so this log helps operators correlate requests).

**Current status:** DEFER — log is intentional for compliance auditing. Consider redaction if Vercel logs are shared with third parties.

---

### 2. Instagram User ID Mismatch

**File:line:** `src/lib/social/instagram.ts:132`

**What it logs:**
```typescript
console.warn(`IG verify: stored userId ${igUserId} != token's ${json.user_id}`);
```

**Risk:** LOW-MEDIUM — logs Instagram user IDs (both stored and token-returned). IG user IDs are semi-public (visible in Graph API responses) but could be considered PII in aggregate.

**Recommended action:**
- Redact the IDs: `console.warn("IG verify: stored userId mismatch (stored != token)")`.
- OR: add a flag `VERBOSE_OAUTH_LOGS` to enable detailed ID logging only in dev/staging.

**Current status:** LOW urgency — IG user IDs are not secrets (they're in API responses), but logging them ties a workspace to a specific IG account. Consider redaction for privacy hygiene.

---

### 3. Stripe Subscription/Price ID Logging

**File:line:** `src/app/api/webhooks/stripe/route.ts:260`

**What it logs:**
```typescript
console.error(
  `[stripe-webhook] price ${priceId} did not match any STRIPE_PRICE_* env var. ` +
    `Subscription ${sub.id} for workspace ${args.workspaceId} is being downgraded to hobby. ...`
);
```

**Risk:** LOW — logs Stripe subscription ID, price ID, and workspace ID. These are internal identifiers, not secrets, but logging them together creates a revenue trail. Subscription IDs are sensitive in aggregate (could infer customer count, churn).

**Recommended action:**
- Redact subscription ID: `Subscription <redacted> for workspace ${args.workspaceId}...`.
- OR: keep as-is but restrict Vercel log access to billing/ops team only.

**Current status:** ACCEPTABLE — subscription IDs are not secrets (operators need them for Stripe Dashboard lookups), but consider access control if logs are widely shared.

**File:line:** `src/app/api/webhooks/stripe/route.ts:187`

Similar log for org subscriptions (same risk/recommendation).

---

## LOW-Risk Logs (Safe Error/Warning Logs)

All remaining `console.*` calls (87 total) are safe error/warning logs that don't expose secrets, tokens, or PII. Examples:

### Safe Patterns

**Error message only (no secrets):**
- `src/app/(app)/goals/[id]/replan-actions.ts:288` — `console.warn("Failed to stamp replan proposal as accepted:", stampErr);`
- `src/app/(app)/plans/[id]/post-timing-explainer.tsx:30` — `console.error("[post-timing-explainer] failed", { error, workspaceId });`

**Non-sensitive IDs:**
- `src/app/(app)/goals/[id]/actions.ts:365` — `console.warn("Goal-anchored generator dropped posts for unconnected channels:", skipped);`
- `src/lib/threads/post.ts:185` — `console.warn(\`thread ledger write failed for ${row.id}: ${ledgerErr.message}\`);`

**Feature flags / config issues:**
- `src/app/(app)/plans/new/actions.ts:429` — `console.warn("Plan video key-status check failed; skipping videos:", err);`
- `src/app/(app)/plans/new/actions.ts:458` — `console.warn("Plan UGC key/avatar check failed; skipping UGC videos:", err);`

**Analytics (hashed handles):**
- `src/lib/preview/analytics.ts:55` — `console.log(JSON.stringify(line));` — logs event metadata with hashed handles (privacy-preserving).

**Discord link failure (non-sensitive):**
- `src/app/api/integrations/discord/action/route.ts:276` — `console.log("[discord] link-prompt follow-up failed:", (e as Error).message);`

### Verified Safe Areas

**OAuth token exchange paths:**
- No console.* calls in `/api/oauth/*/callback/route.ts` (verified via grep).
- Token exchange failures throw errors (caught by Next.js error boundary) but never log token values.

**BYO key encryption:**
- `src/lib/video/byo-keys.ts` — NO console.* calls. Plaintext keys stay in-memory only; DB stores ciphertext.

**Webhook signature verification:**
- `src/app/api/webhooks/stripe/route.ts` — signature errors return 400 but never log the raw body or signature value.

---

## Full Inventory (File:Line)

### Actions
- `src/app/(app)/goals/[id]/replan-actions.ts:288` — warn: stamp failure (safe)
- `src/app/(app)/goals/[id]/actions.ts:351` — warn: goal status flip (safe)
- `src/app/(app)/goals/[id]/actions.ts:357` — warn: usage counter (safe)
- `src/app/(app)/goals/[id]/actions.ts:365` — warn: skipped channels (safe)
- `src/app/(app)/plans/new/actions.ts:346` — warn: Smart Timing fallback (safe)
- `src/app/(app)/plans/new/actions.ts:429` — warn: video key check (safe)
- `src/app/(app)/plans/new/actions.ts:458` — warn: UGC key check (safe)
- `src/app/(app)/plans/new/actions.ts:606` — warn: usage counter (safe)
- `src/app/(app)/plans/new/actions.ts:617` — warn: hashtag backfill (safe)
- `src/app/(app)/plans/new/actions.ts:642` — warn: auto-tag failure (safe)
- `src/app/(app)/plans/new/actions.ts:676` — warn: video kickoff (safe)
- `src/app/(app)/plans/new/actions.ts:721` — warn: UGC kickoff (safe)
- `src/app/(app)/plans/new/actions.ts:730` — warn: skipped channels (safe)
- `src/app/(app)/dashboard/actions.ts:325` — warn: usage counter (safe)
- `src/app/(app)/dashboard/actions.ts:331` — warn: skipped channels (safe)
- `src/app/(app)/queue/actions.ts:393` — warn: usage counter (safe)
- `src/app/(app)/queue/actions.ts:676` — warn: hashtag upsert (safe)
- `src/app/(app)/queue/actions.ts:760` — warn: hashtag upsert (safe)
- `src/app/(app)/sources/[id]/actions.ts:295` — warn: usage counter (safe)
- `src/app/(app)/sources/[id]/actions.ts:302` — warn: skipped channels (safe)
- `src/app/(app)/sources/[id]/atomize-actions.ts:240` — warn: usage counter (safe)
- `src/app/(app)/sources/[id]/atomize-actions.ts:246` — warn: skipped channels (safe)
- `src/app/(app)/variations/actions.ts:105` — warn: usage counter (safe)

### Pages / Components
- `src/app/(app)/plans/[id]/page.tsx:194` — error: explainer failure (safe)
- `src/app/(app)/plans/[id]/post-timing-explainer.tsx:30` — error: explainer (safe)
- `src/app/(auth)/integrations/discord/link/page.tsx:121` — log: insert failure (safe)

### API Routes
- `src/app/api/integrations/discord/action/route.ts:276` — log: link-prompt failure (safe)
- `src/app/api/webhooks/stripe/route.ts:187` — error: org price mismatch (LOW risk)
- `src/app/api/webhooks/stripe/route.ts:260` — error: price mismatch (LOW risk)
- `src/app/api/data-deletion/route.ts:132` — log: FB deletion payload (MEDIUM risk)

### Cron Routes
- `src/app/api/cron/email-digest/route.ts:155` — warn: neglected-theme detection (safe)
- `src/app/api/cron/goal-replan-check/route.ts:89` — error: replan failure (safe)
- `src/app/api/cron/weekly-growth/route.ts:81` — warn: workspace failure (safe)
- `src/app/api/cron/weekly-growth/route.ts:261` — warn: run record failure (safe)
- `src/app/api/cron/learning-digest/route.ts:58` — warn: workspace failure (safe)
- `src/app/api/cron/competitor-watch/route.ts:315` — warn: research failure (safe)

### Lib (Business Logic)
- `src/lib/interactions/send-core.ts:89` — warn: DM send failure (safe)
- `src/lib/interactions/auto-reply/dm-send.ts:414` — warn: audit log (safe)
- `src/lib/interactions/auto-reply/send.ts:361` — warn: audit log (safe)
- `src/lib/interactions/auto-reply/spam-ignore.ts:223` — warn: spam_score persist (safe)
- `src/lib/interactions/auto-reply/spam-ignore.ts:256` — warn: audit log (safe)
- `src/lib/interactions/auto-reply/lead-capture.ts:147` — warn: post_outcomes (safe)
- `src/lib/interactions/auto-reply/lead-capture.ts:152` — warn: outcomes (safe)
- `src/lib/video/plan-ugc.ts:134` — warn: video kickoff (safe)
- `src/lib/video/plan-videos.ts:158` — warn: video kickoff (safe)
- `src/lib/portal/manage.ts:110` — error: invite lookup (safe)
- `src/lib/portal/manage.ts:168` — error: invite lookup (safe)
- `src/lib/portal/manage.ts:187` — error: membership upsert (safe)
- `src/lib/portal/invite-email.ts:160` — warn: email skip (safe)
- `src/lib/portal/invite-email.ts:185` — error: email send (safe)
- `src/lib/portal/invite-email.ts:191` — error: email threw (safe)
- `src/lib/plan/competitor-research.ts:42` — warn: research failure (safe)
- `src/lib/plan/competitor-research.ts:56` — warn: research failure (safe)
- `src/lib/plan/competitor-research.ts:71` — warn: research failure (safe)
- `src/lib/plan/competitor-research.ts:97` — warn: research failure (safe)
- `src/lib/plan/competitor-research-discover.ts:90` — warn: discovery failure (safe)
- `src/lib/plan/competitor-research-discover.ts:109` — warn: discovery failure (safe)
- `src/lib/plan/competitor-research-discover.ts:150` — warn: discovery failure (safe)
- `src/lib/plan/competitor-research-discover.ts:156` — warn: discovery failure (safe)
- `src/lib/plan/competitor-research-shared.ts:176` — warn: research failure (safe)
- `src/lib/plan/competitor-research-shared.ts:183` — warn: research failure (safe)
- `src/lib/plan/competitor-research-summarise.ts:51` — warn: summary failure (safe)
- `src/lib/plan/competitor-research-summarise.ts:105` — warn: summary failure (safe)
- `src/lib/tags/persist.ts:84` — warn: auto-tag failure (safe)
- `src/lib/tags/persist.ts:138` — warn: auto-tag regen (safe)
- `src/lib/tags/persist.ts:156` — warn: loadRecommended (safe)
- `src/lib/tags/generate.ts:263` — warn: LLM fallback (safe)
- `src/lib/dashboard/learning-digest.ts:56` — warn: theme winners (safe)
- `src/lib/dashboard/learning-digest.ts:60` — warn: AI review (safe)
- `src/lib/growth/weekly-digest.ts:306` — warn: shipped load (safe)
- `src/lib/growth/weekly-digest.ts:310` — warn: theme outcomes (safe)
- `src/lib/growth/weekly-digest.ts:314` — warn: winners (safe)
- `src/lib/growth/weekly-digest.ts:318` — warn: community summary (safe)
- `src/lib/growth/weekly-digest.ts:459` — warn: narrative call (safe)
- `src/lib/social/instagram.ts:132` — warn: userId mismatch (LOW-MEDIUM risk)
- `src/lib/billing/org-subscription.ts:176` — error: org lookup (safe)
- `src/lib/billing/org-subscription.ts:193` — error: org update (safe)
- `src/lib/threads/post.ts:185` — warn: ledger write (safe)
- `src/lib/hashtags/recommend.ts:92` — warn: load failure (safe)
- `src/lib/preview/analytics.ts:55` — log: event JSON (safe — hashed handles)
- `src/lib/voice-memo/persist.ts:227` — warn: usage counter (safe)
- `src/lib/explain/orchestrator.ts:81` — error: explainer failure (safe)
- `src/lib/brand/load.ts:79` — warn: brand load (safe)
- `src/lib/goals/lineage.ts:74` — warn: cycle detected (safe)

### Comments (Not Logs)
- `src/app/(app)/settings/video-keys/key-forms.tsx:30` — comment referencing "console" (not a log)
- `src/app/(app)/settings/video-keys/key-forms.tsx:47` — keyUrl pointing to console.aliyun.com (not a log)
- `src/app/(app)/settings/video-keys/key-forms.tsx:52` — keyUrl pointing to console.bce.baidu.com (not a log)
- `src/app/(app)/settings/video-keys/key-forms.tsx:60` — comment referencing "console" (not a log)
- `src/lib/env.ts:124` — comment with URL https://console.groq.com/keys (not a log)
- `src/lib/goals/reverse-plan.ts:35` — comment referencing console.anthropic.com (not a log)

---

## Recommendations

### Priority 1 (MEDIUM risk — address before public launch)
1. **Redact Facebook user_id** in `src/app/api/data-deletion/route.ts:132` OR move to audit table.
2. **Redact IG user IDs** in `src/lib/social/instagram.ts:132` OR gate behind verbose-logging flag.

### Priority 2 (LOW risk — address for compliance hygiene)
3. **Redact Stripe subscription IDs** in `src/app/api/webhooks/stripe/route.ts:187,260` OR restrict Vercel log access.

### Priority 3 (Proactive hygiene)
4. **Audit Vercel log retention** — ensure logs older than 30 days are purged (GDPR right-to-erasure).
5. **Add log-scrubbing middleware** — intercept console.* calls in production and auto-redact patterns like `/sk_live_[a-zA-Z0-9]+/`, `/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/` (JWT), etc.
6. **Move audit logs to database** — sensitive events (data deletion, subscription changes) should write to an audit table, not function logs.

---

## Verified Safe: No Logs in Critical Paths

**OAuth token exchange:**
- `src/app/api/oauth/*/callback/route.ts` — NO console.* calls (verified via grep).
- Access tokens never logged.

**BYO key encryption:**
- `src/lib/video/byo-keys.ts` — NO console.* calls.
- Plaintext keys stay in-memory only.

**Webhook signature verification:**
- `src/app/api/webhooks/stripe/route.ts` — NO logs of raw body or signature.

---

## Summary

- **HIGH-risk logs:** 0 ✅
- **MEDIUM-risk logs:** 3 (FB user_id, IG user_id, Stripe sub IDs)
- **LOW-risk logs:** 87 (safe error/warning logs)

**Headline finding:** No confirmed secret/token leaks. The codebase follows good hygiene (OAuth tokens, API keys, passwords never logged). The 3 MEDIUM-risk logs are PII/sensitive-IDs that should be redacted or access-controlled before public launch.

**Next steps:**
1. Review MEDIUM-risk logs with legal/compliance team.
2. Implement redaction for FB user_id + IG user_ids.
3. Restrict Vercel log access to ops/billing team only (or redact Stripe IDs).
4. Add this report to the security review checklist for future code changes.
