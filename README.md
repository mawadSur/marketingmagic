# marketingmagic

A social **growth engine**, not just a scheduler. marketingmagic auto-generates
on-brand posting plans, publishes across seven channels with hybrid approval,
generates AI short-form + UGC video, and learns which content themes actually
drive engagement — then doubles down.

See [`PLAN.md`](./PLAN.md) for the full architecture and data model, and
[`FEATURES.md`](./FEATURES.md) for the capability list.

## Status

Live in production. Seven channels, plan generation, hybrid trust-mode
auto-posting, Bayesian theme-winner learning loop, AI video (MPT stock-footage +
reference-image / talking-avatar / UGC), an agency/organization layer, and a
client portal are all shipped. 326 unit tests; e2e (Playwright) + an opt-in
live-credential channel smoke.

## Channels

| Channel | Connect | Publish | Notes |
|---------|---------|---------|-------|
| X | OAuth 2.0 PKCE | ✅ text + image + video | refresh-on-demand |
| Instagram | IG Login | ✅ image + Reels | business/creator account; image required |
| Facebook | Login for Business | ✅ text + video | Page-scoped token |
| Threads | OAuth | ✅ text + image + video | Meta Graph |
| Bluesky | app password | ✅ text + image + video | AT Protocol |
| LinkedIn | OAuth | member + org posting | org posting pending CMA review |
| TikTok | OAuth 2.0 PKCE | video-only | pending app audit |

## Running locally

```bash
cp .env.local.example .env.local   # fill in real values (see "Environment")
supabase db push                   # applies all migrations (001 → 039)
npm run dev
```

### Environment

Required to boot: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `CRON_SECRET`. Per-feature
(graceful-degrade when unset): per-channel OAuth keys, `FAL_API_KEY` (images),
`STRIPE_*` (billing), `RESEND_API_KEY` + `EMAIL_LINK_SECRET` (digests),
`MPT_BASE_URL`/`MPT_API_TOKEN` + `BYO_ENCRYPTION_KEY` (video), and
`REFERENCE_VIDEO_ENABLED` (reference-image / UGC video).

## Testing

```bash
npm test                  # unit + integration (Vitest)
npm run test:channels     # mocked per-channel OAuth/connect lifecycle (no creds)
npm run test:e2e          # Playwright (needs a dev server + Supabase service key)
npm run test:e2e:channels # connect-tile OAuth-initiate smoke for all channels
npm run test:channels:live  # OPT-IN: hit real provider APIs with stored tokens
npm run typecheck && npm run build
```

## Cron

Vercel Cron hits the handlers in `src/app/api/cron/*`, each gated by
`Authorization: Bearer $CRON_SECRET` (see `vercel.json`): `post-scheduled`,
`pull-metrics`, `poll-video-jobs`, `poll-interactions`, `competitor-watch`,
`learning-digest`, `email-digest`, `engagement-report`, `goal-replan-check`,
`theme-gaps`, `voice-evolution`.

## Webhook ingestion

Each workspace has a signing secret at `/settings/events`. External systems POST
JSON to `/api/webhooks/<workspace_id>` with `X-MM-Signature: sha256=<hex>`
computed over the raw body using that secret.

## Stack

- Next.js 16 (App Router, server components + server actions)
- Supabase (Postgres + RLS auth + Storage)
- Claude (Opus 4.8) via `@anthropic-ai/sdk` — plan/voice/source/strategy generation
- TailwindCSS + shadcn-style UI
- Vercel (hosting + cron)
- BYO render worker (MoneyPrinterTurbo) + BYO provider keys for AI video

## Repo conventions

- `supabase/migrations/` — sequential SQL files, applied via `supabase db push`
- `src/app/api/cron/*` — Vercel Cron handlers (auth via `Authorization: Bearer $CRON_SECRET`)
- `src/app/api/oauth/<channel>/` — per-channel connect (initiate + callback)
- `src/app/api/webhooks/[workspace_id]/` — signed event ingestion
- `src/lib/social/<channel>.ts` — per-channel post + OAuth helpers
- `src/lib/video/` — render orchestration, BYO keys, provider adapters
- `src/lib/plan/` — plan generation prompts + JSON schemas
