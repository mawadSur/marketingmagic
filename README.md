# marketingmagic

Multi-tenant marketing automation: auto-generated posting plans, hybrid-approval auto-posting, data-driven theme iteration.

See [`PLAN.md`](./PLAN.md) for the full architecture, data model, and build sequence.

## Status

V0 in progress. Schema drafted in `supabase/migrations/001_init.sql`. Next.js scaffold not yet generated — see PLAN.md "Build sequence (V0)" for what's next.

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
