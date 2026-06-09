# Secret Rotation Runbook

## Overview

This document provides the step-by-step procedures for rotating critical secrets in the MarketingMagic production environment. Each secret has specific rotation requirements to avoid service disruption.

All secrets are defined and validated in `src/lib/env.ts`.

---

## 1. SUPABASE_SERVICE_ROLE_KEY

**Risk:** HIGH — service-role key bypasses RLS; grants full database access.

**Where it's read:**
- `src/lib/env.ts` (serverEnv)
- `src/lib/supabase/service.ts` (supabaseService)

**Rotation procedure:**

1. **In Supabase Dashboard** (Project Settings → API):
   - Generate a new service_role key OR regenerate the existing key (this invalidates the old one immediately).

2. **Update Vercel env vars** (Settings → Environment Variables):
   - Set `SUPABASE_SERVICE_ROLE_KEY` to the new key.
   - Apply to Production, Preview, and Development environments.

3. **Redeploy immediately:**
   - Trigger a production deployment (push to main or manual deploy).
   - The old key is invalid as soon as Supabase regenerates — the app WILL break until redeployed with the new key.

4. **Verify:**
   - Check logs for Supabase auth errors.
   - Test a server action (e.g., create a post in /queue).

**Downtime:** ~30s (time between Supabase invalidation and Vercel redeploy).

---

## 2. ANTHROPIC_API_KEY

**Risk:** HIGH — Claude LLM access for all content generation.

**Where it's read:**
- `src/lib/env.ts` (serverEnv)
- `src/lib/ai/client.ts` (Anthropic SDK)

**Rotation procedure:**

1. **In Anthropic Console** (console.anthropic.com/settings/keys):
   - Create a new API key.
   - **DO NOT delete the old key yet.**

2. **Update Vercel env vars:**
   - Set `ANTHROPIC_API_KEY` to the new key.
   - Apply to all environments.

3. **Redeploy:**
   - Trigger production deployment.

4. **Verify:**
   - Test content generation (e.g., create a new plan in /plans/new).
   - Check logs for Anthropic API errors.

5. **Revoke old key:**
   - After 24h of stable operation, delete the old key in Anthropic Console.

**Downtime:** None (graceful cutover if old key stays active during deploy).

---

## 3. STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET

**Risk:** HIGH — billing data access + subscription webhooks.

**Where they're read:**
- `src/lib/env.ts` (serverEnv)
- `src/lib/billing/stripe.ts` (stripeClient)
- `src/app/api/webhooks/stripe/route.ts` (webhook handler)

**Rotation procedure (SECRET_KEY):**

1. **In Stripe Dashboard** (Developers → API keys):
   - Roll the secret key (generates new, invalidates old).

2. **Update Vercel env vars:**
   - Set `STRIPE_SECRET_KEY` to the new key.
   - Apply to all environments.

3. **Redeploy immediately:**
   - The old key is invalid as soon as rolled.

4. **Verify:**
   - Test checkout flow (/settings/billing → upgrade).
   - Check subscription status updates.

**Rotation procedure (WEBHOOK_SECRET):**

1. **In Stripe Dashboard** (Developers → Webhooks):
   - Create a NEW webhook endpoint pointing to the same URL.
   - Copy the new signing secret.
   - **DO NOT delete the old endpoint yet.**

2. **Update Vercel env vars:**
   - Set `STRIPE_WEBHOOK_SECRET` to the new signing secret.
   - Apply to all environments.

3. **Redeploy:**
   - Wait for deploy to complete.

4. **Verify webhook:**
   - In Stripe Dashboard, send a test event to the new endpoint.
   - Check Vercel logs for successful signature verification.

5. **Delete old webhook endpoint:**
   - After 24h of stable operation, disable the old endpoint.

**Downtime:** ~30s for SECRET_KEY; none for WEBHOOK_SECRET (dual endpoint cutover).

---

## 4. OAuth Client Secrets

**Providers:** X, LinkedIn, Meta (Instagram/Threads/Facebook), TikTok, YouTube

**Risk:** MEDIUM — channel connection flows broken until rotated.

**Where they're read:**
- `src/lib/env.ts` (serverEnv)
- OAuth initiate/callback routes in `src/app/api/oauth/*`

**General rotation procedure:**

1. **In provider console:**
   - Regenerate the client secret (or create a new OAuth app).
   - **DO NOT delete the old secret yet** (if provider allows multiple active secrets).

2. **Update Vercel env vars:**
   - Set the corresponding `*_CLIENT_SECRET` var to the new secret.
   - Apply to all environments.

3. **Redeploy:**
   - Trigger production deployment.

4. **Verify:**
   - Test OAuth flow for the rotated channel (/channels → Connect).
   - Check callback route logs for auth errors.

5. **Revoke old secret:**
   - After 24h of stable operation, delete the old secret in the provider console.

**Provider-specific vars:**
- X: `X_CLIENT_SECRET`
- LinkedIn: `LINKEDIN_CLIENT_SECRET`
- Instagram: `INSTAGRAM_APP_SECRET`
- Threads: `THREADS_APP_SECRET`
- Meta (umbrella): `META_APP_SECRET`
- TikTok: `TIKTOK_CLIENT_SECRET`
- YouTube: `YOUTUBE_CLIENT_SECRET`

**Downtime:** None (graceful cutover if old secret stays active during deploy).

---

## 5. CRON_SECRET

**Risk:** MEDIUM — cron route protection (poll-interactions, email-digest, etc.).

**Where it's read:**
- `src/lib/env.ts` (serverEnv)
- All `/api/cron/*` routes (Authorization header check)

**Rotation procedure:**

1. **Generate a new secret:**
   - Use a cryptographically secure random generator: `openssl rand -base64 32`
   - Min 16 chars (validated in env.ts).

2. **Update Vercel env vars:**
   - Set `CRON_SECRET` to the new secret.
   - Apply to all environments.

3. **Update Vercel Cron job headers:**
   - In Vercel Dashboard → Cron Jobs, edit EACH cron job.
   - Update the `Authorization: Bearer <CRON_SECRET>` header to the new secret.
   - **This is critical — if headers don't match, crons fail with 401.**

4. **Redeploy:**
   - Trigger production deployment.

5. **Verify:**
   - Wait for the next scheduled cron run.
   - Check logs for successful auth (no 401 errors).

**Downtime:** None if header + env var are updated together. Crons fail until both are synced.

---

## 6. BYO_ENCRYPTION_KEY

**Risk:** CRITICAL — rotating this key BREAKS all stored BYO credentials.

**Where it's read:**
- `src/lib/env.ts` (serverEnv)
- `src/lib/video/byo-keys.ts` (encrypt/decrypt for workspace_byo_keys)

**⚠️ BREAKING CHANGE WARNING:**

Rotating `BYO_ENCRYPTION_KEY` invalidates ALL existing rows in the `workspace_byo_keys` table. Every workspace's stored LLM/Pexels/fal/D-ID/HeyGen/Higgsfield/analysis keys become undecryptable.

**Rotation procedure (DESTRUCTIVE):**

1. **Notify users:**
   - Announce at least 7 days in advance that BYO keys must be re-entered.
   - Provide re-entry instructions (/settings/video-keys).

2. **Generate a new 32-byte key:**
   - `openssl rand -base64 32` (44 chars base64) OR `openssl rand -hex 32` (64 chars hex).

3. **Update Vercel env vars:**
   - Set `BYO_ENCRYPTION_KEY` to the new key.
   - Apply to all environments.

4. **Clear the workspace_byo_keys table:**
   - In Supabase SQL Editor: `TRUNCATE workspace_byo_keys;`
   - This prevents decrypt errors on stale ciphertext.

5. **Redeploy:**
   - Trigger production deployment.

6. **Users re-enter keys:**
   - Each workspace owner must visit /settings/video-keys and re-enter their BYO credentials.

**Downtime:** Video features unavailable until users re-enter keys (could be days/weeks for inactive workspaces).

**Recommendation:** ONLY rotate BYO_ENCRYPTION_KEY if it's been compromised. For routine key hygiene, prefer rotating the provider API keys (LLM/Pexels/etc.) instead, which users control.

---

## 7. Other Optional Secrets

### FAL_API_KEY
- Used for image generation (fal.ai).
- Rotation: update Vercel env var + redeploy.
- Impact: image generation fails until redeployed.

### RESEND_API_KEY + EMAIL_LINK_SECRET
- Used for transactional email (daily digest).
- Rotation: update Vercel env vars + redeploy.
- Impact: email digest fails until redeployed.

### GROQ_API_KEY
- Used for Whisper transcription (audio/video source ingestion).
- Rotation: update Vercel env var + redeploy.
- Impact: transcription fails until redeployed.

### MPT_API_TOKEN
- Used for MoneyPrinterTurbo render worker auth.
- Rotation: update Vercel env var + MPT service config + redeploy both.
- Impact: video rendering fails until synced.

### DISCORD_CLIENT_SECRET + DISCORD_BOT_TOKEN
- Used for Discord bot integration.
- Rotation: update Vercel env vars + redeploy.
- Impact: Discord bot install/commands fail until redeployed.

### WEBHOOK_DEV_SECRET
- Used for local webhook testing (not production).
- Rotation: update .env.local + restart dev server.

---

## Emergency Rotation Checklist

If a secret is compromised and must be rotated IMMEDIATELY:

1. **Identify the secret** (check logs/alerts for the leaked value).
2. **Invalidate the old secret** (provider console: revoke/regenerate).
3. **Update Vercel env var** (all environments).
4. **Redeploy NOW** (don't wait for CI — manual trigger if needed).
5. **Verify the app is healthy** (smoke test critical paths).
6. **Audit access logs** (check for unauthorized usage of the old secret).
7. **Notify users** (if user-facing features were disrupted).

**Priority order (most critical first):**
1. SUPABASE_SERVICE_ROLE_KEY (full DB access)
2. STRIPE_SECRET_KEY (billing/PII)
3. BYO_ENCRYPTION_KEY (stored user secrets)
4. ANTHROPIC_API_KEY (cost exposure)
5. OAuth client secrets (UX disruption)
6. CRON_SECRET (background job auth)
7. Other optional keys (feature-specific)

---

## Testing Secret Rotation (Staging)

Before rotating production secrets, test the procedure in a staging/preview environment:

1. Set up a preview deployment with its own Supabase project + Stripe test mode.
2. Rotate the secret in the staging provider console.
3. Update Vercel preview env vars.
4. Trigger a preview deploy.
5. Smoke test affected features.
6. Document any gotchas (e.g., Stripe webhook endpoint URL mismatch).

**Recommended staging cadence:** Rotate secrets in staging every 90 days to keep runbook current.

---

## Logging and Monitoring

**What to watch after rotation:**
- Vercel function logs (search for auth errors: "unauthorized", "invalid key", "signature", "401", "403").
- Sentry error rate (spikes after deploy indicate bad config).
- Cron job success rate (Vercel Cron → Logs).
- User-reported issues (Discord/support channels).

**Log hygiene:** See `docs/log-hygiene-report.md` for audit of console.* calls that might leak secrets.

---

## References

- `src/lib/env.ts` — all env var definitions + validation
- `src/lib/supabase/service.ts` — SUPABASE_SERVICE_ROLE_KEY usage
- `src/lib/billing/stripe.ts` — Stripe key usage
- `src/lib/video/byo-keys.ts` — BYO_ENCRYPTION_KEY usage
- `src/app/api/webhooks/stripe/route.ts` — Stripe webhook signature verification
- `src/app/api/cron/*` — CRON_SECRET auth checks
- `src/app/api/oauth/*` — OAuth client secret usage
