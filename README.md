# marketingmagic

Multi-tenant marketing automation: auto-generated posting plans, hybrid-approval auto-posting, data-driven theme iteration.

See [`PLAN.md`](./PLAN.md) for the full architecture, data model, and build sequence.

## Status

V0 + V1 scaffold landed. Next.js 16 app builds; cron handlers, plan generator, approval queue, dashboard, event ingestion, hybrid trust-mode, KPI-weighted regeneration all wired. Needs real env values (Supabase project, Anthropic API key, X credentials) before it can run end-to-end.

## Running locally

```bash
cp .env.local.example .env.local   # fill in real values
supabase db push                   # applies migrations 001 + 002
npm run dev
```

## Cron secrets

Vercel Cron hits `/api/cron/post-scheduled` every 5 min and `/api/cron/pull-metrics` hourly. Both require `Authorization: Bearer $CRON_SECRET`. See `vercel.json`.

## Webhook ingestion

Each workspace has a signing secret at `/settings/events`. External systems POST JSON to `/api/webhooks/<workspace_id>` with `X-MM-Signature: sha256=<hex>` computed over the raw body using that secret.

## Stack

- Next.js 16 (App Router)
- Supabase (Postgres + RLS auth)
- Claude Sonnet 4.6 via `@anthropic-ai/sdk`
- TailwindCSS + shadcn/ui
- Vercel (hosting + cron)

## Channel rollout

V0: X · V1.5: Instagram + Facebook · V2: Threads + Bluesky · V3: LinkedIn

## Repo conventions

- `supabase/migrations/` — sequential SQL files, applied via `supabase db push`
- `app/api/cron/*` — Vercel Cron handlers (auth via `Authorization: Bearer $CRON_SECRET`)
- `app/api/webhooks/[workspace_id]/` — event ingestion endpoints (signed)
- `lib/social/<channel>.ts` — per-channel post helpers (tweet, ig-post, etc.)
- `lib/plan/` — plan generation prompts + JSON schemas
