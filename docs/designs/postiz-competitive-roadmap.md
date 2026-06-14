# marketingmagic vs Postiz — competitive roadmap

Generated 2026-06-12 from a `/plan-ceo-review` comparative analysis against
`gitroomhq/postiz-app` (read via the GitHub API; 1,193-path source tree).

## TL;DR thesis

Don't out-channel Postiz. Out-**intelligence** them, and make that intelligence
**agent-callable** so we ride the automation ecosystem instead of fighting the
channel-count war. Strategic posture chosen: **Hybrid — agent-native core first,
then a few killer channels, while widening the AI moat.**

## What each product is

- **Postiz** = horizontal distribution platform. AGPL-3.0, self-hostable, ~3M
  Docker pulls. Monorepo: NextJS frontend + NestJS backend + **Temporal**
  orchestrator + Prisma/Postgres. Moat = **breadth + ecosystem** (30+ channels,
  public API, NodeJS SDK, n8n/Make/Zapier nodes, MCP server + agent CLI, Chrome
  extension).
- **marketingmagic** = vertical growth engine. Next.js 16 + Supabase + Stripe,
  single app, 13-cron automation engine. Moat = **depth of outcome** (AI plan
  generation, Bayesian theme-winner learning loop, deep AI video, agency/client
  portal, voice learning, competitor research, goals).

## Channel gap

We have 8 (X, Instagram, Facebook, Threads, Bluesky, LinkedIn, TikTok, YouTube).
Postiz has 30+. Missing high-value: **Google Business Profile, Reddit, Pinterest,
Discord, Slack**, blogging cluster (Medium/Dev.to/Hashnode/WordPress), plus a long
tail (Mastodon, Farcaster, Nostr, Twitch, Kick, VK, etc.).

## Capability matrix

| Capability | us | Postiz | Edge |
|---|---|---|---|
| Schedule/queue across channels | yes | yes | tie |
| AI full-plan generation (whole calendar) | strong | copilot/autopost only | **us** |
| Learning loop (Bayesian theme-winner) | yes | no | **us** |
| AI video (short-form, UGC avatar, ref-image) | deep | shallow | **us** |
| Voice profile + evolution | yes | no | **us** |
| Agency/org + client portal + reports | yes | enterprise-lite | **us** |
| Competitor research / goals / timing heatmap | yes | no | **us** |
| Inbox + AI auto-reply | yes | no | **us** |
| Public REST API + SDK | **no** | yes | **them** |
| MCP server + agent CLI | **no** | yes | **them** |
| n8n / Make / Zapier nodes | **no** | yes | **them** |
| Outbound webhooks (SSRF-safe) | inbound only | yes | **them** |
| Short-linking + UTM attribution | **no** | yes (dub/kutt/short.io) | **them** |
| Chrome extension (cookie platforms) | no | yes | **them** |
| Marketplace (buy/sell posts) | no | yes | **them** |
| Open-source distribution / community | no | yes (3M pulls) | **them** |

We win on intelligence/outcomes; they win on reach/integrations and being
agent/automation-native.

## Roadmap (Hybrid posture)

### Phase 0 — truth-in-advertising (do first, ~1 hr CC)
- README stale: says "seven channels" (we have 8) and "migrations 001 → 039"
  (we are at 065). Fix.
- No `FEATURES.md` despite README link. Create or drop the link.

### Phase 1 — agent-native core (P0, the platform bet)
1. **Public REST API v1** — ✅ SHIPPED 2026-06-12. Migration 066 (`api_keys`,
   SHA-256-hashed, scoped, soft-revoke), `src/lib/api/` (keys/errors/context/
   middleware), routes `/api/v1/channels`, `/api/v1/posts`, `/api/v1/posts/[id]`.
   Posts write `status='scheduled'` and reuse the existing post-scheduled cron
   (idempotency + retry for free). Tenant isolation enforced in `WorkspaceApi`
   (service client bypasses RLS — every query is workspace-scoped in code). +29
   tests incl. a cross-tenant isolation proof. Build + 847 tests green. Ships
   DARK until the api-keys UI (#2) lets users mint keys. (was: human ~1wk / CC ~1 day)
   DEFERRED to a follow-up: `/api/v1/media`, `/api/v1/plans`, `/api/v1/analytics`
   routes (the lib + middleware already support them; just need the thin handlers).
2. **API-key management UI** — ✅ SHIPPED 2026-06-12. `/settings/api-keys` (mirrors
   `settings/video-keys`): create form with scope checkboxes + one-time raw-key
   reveal, list with per-key scopes/last-used + revoke. `src/lib/api/manage.ts`
   (cookie-authed, RLS + explicit workspace_id scoping). Added to settings nav.
   +8 tests (create-returns-raw-once, list-never-leaks-hash, revoke-is-workspace-
   scoped). **The API is now LIVE, not dark** — users can mint keys. (was: human ~1 day / CC ~1hr)
3. **MCP server** — thin wrapper over v1 API; makes our AI depth agent-callable.
   (human ~3 days / CC ~3hr)
4. **Outbound webhooks (SSRF-safe)** — `post.published` / `post.failed` /
   `plan.created`. Copy Postiz's `ssrf.safe.dispatcher.ts` + URL validator pattern.
   (human ~2 days / CC ~2hr)
5. **n8n node + Zapier/Make** — thin clients over the API once 1+4 exist.
   (human ~2 days / CC ~half-day)

Sequencing: 1 → 2 → (3 ‖ 4) → 5.

### Phase 2 — a few killer channels (P1, not 30)
6. **Google Business Profile** — local/SMB; Google OAuth plumbing already exists
   from YouTube. (human ~3 days / CC ~3hr)
7. **Reddit** — reach + community; pairs with voice/competitor research.
   (human ~3 days / CC ~3hr)
8. **Pinterest** — visual/commerce; pairs with our AI image/video gen.
   (human ~2 days / CC ~2hr)
9. **Discord + Slack** (broadcast) — cheapest to add, no heavy OAuth audit.
   (human ~1 day each / CC ~1hr each)

NOT now: blogging cluster, Mastodon/Farcaster/Nostr, Twitch/Kick/VK/Mewe/Lemmy.
Long tail — revisit only on paying-customer demand.

### Phase 3 — widen the AI moat (P1/P2, where we win)
10. **Short-links + UTM attribution** — looks like parity but for us it CLOSES THE
    LEARNING LOOP: attribute clicks/conversions to themes, not just likes. Highest
    leverage item on the list. (human ~3 days / CC ~3hr)
11. **Brand-consistent image/video gen** — already in `docs/TODO.md`. (human ~1wk / CC ~half-day)
12. **Autopilot mode** — plan → render → schedule → publish → learn, hands-off.
    (human ~1wk / CC ~1 day)
13. **Spam auto-ignore + voice-from-sent-messages** — `docs/TODO.md` #0. (M / CC ~half-day)

## If cut to three
#1 (public API), #3 (MCP server), #10 (short-link attribution). API+MCP makes us
agent-native; attribution makes the learning loop measure money instead of vanity.

## Architectural note for Phase 1 #1 (load-bearing)
The whole app authenticates via Supabase cookies + RLS (`getAuthedUserOrRedirect`,
`is_workspace_member`). A public API CANNOT use cookies — it authenticates by API
key → resolve workspace → **service client, which BYPASSES RLS**. Therefore every
API query MUST manually scope by `workspace_id`. This is the #1 correctness/security
risk and must be a first-class concern in the API plan (a shared workspace-scoped
query helper, not ad-hoc `.eq('workspace_id', ...)` sprinkled per route).
