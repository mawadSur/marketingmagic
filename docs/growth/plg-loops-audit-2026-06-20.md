# PLG Acquisition Loops Audit — 2026-06-20

Auditor: automated read + live fetch.
Scope: three PLG acquisition loops — Attribution, Free Tools, Referral.

---

## Loop 1: Attribution ("Made with marketingmagic")

### What is live

- `src/lib/growth/attribution.ts` — core logic is fully wired.
- The attribution line reads: `Made with marketingmagic — <siteUrl>/?ref=post`
- Two-gate check: `plan === 'hobby'` AND `attribution_enabled === true`.
- `attribution_enabled` defaults to `true` in migration `031_referrals_attribution.sql:54` — every new Hobby workspace starts with the badge ON.
- Paid workspaces (`plan !== 'hobby'`) bypass the badge regardless of the toggle.
- `applyAttribution` is called at both publish choke-points:
  - `src/app/(app)/queue/actions.ts:942` — publish-now action
  - `src/app/api/cron/post-scheduled/route.ts:252` — scheduled cron
- The toggle to disable (for Hobby users who want it off) is surfaced at `/settings/referrals` via `AttributionToggle` in `src/app/(app)/settings/referrals/referral-controls.tsx:116`.
- The toggle has no paywall — a Hobby user can turn it off with one click for free.

### What is broken / missing

1. **Free users can remove the badge at zero cost.** The toggle is available to all Hobby users with no upgrade prompt. There is no friction at all between "I want this off" and "it's off." This eliminates the billboarding value for the entire free tier. The badge should require upgrading to remove — gating removal behind Creator or higher is the standard PLG model (Notion, Mailchimp, etc.).
   - File: `src/app/(app)/settings/referrals/referral-controls.tsx:116–169`
   - Fix: when `isHobby === true`, replace the "Turn off" button with a `Link href="/pricing"` upgrade prompt: "Remove branding — upgrade to Creator." Only allow the flip action when `!isHobby`.

2. **`ref=post` is a dead analytics param.** The attribution URL appends `?ref=post` to the site root. There is no code anywhere in the app that reads, stores, or tracks this param — no server analytics event, no Vercel analytics tag, no conversion funnel entry. The loop mints leads in theory but there is no way to measure it.
   - Files: `src/lib/growth/attribution.ts:26`, `src/app/page.tsx` (no ref handling found)
   - Fix: in the homepage server component, call `track({ stage: "attribution_click", source: "post" })` when `searchParams.ref === "post"`. This closes the loop from badge → lead → signup attribution.

3. **Badge is appended to post text.** On platforms that render plain text (X, Bluesky, LinkedIn), a trailing `\n\nMade with marketingmagic — https://...` is fine. On Instagram and TikTok the caption is character-limited and the extra ~60 chars eat into the post. No character-count guard exists.
   - Fix (low priority): truncate `text` to `(platformCharLimit - attributionLine().length - 2)` before appending, per-platform.

### Verdict: PARTIAL — badge fires on every Hobby post by default and carries a tracked URL, but the removal gate is missing so any friction-averse user can kill it in one click, and the ref param conversion data is never captured.

---

## Loop 2: Free Tools (SEO top-of-funnel)

### What is live

- `/tools` hub, `/tools/handle-checker`, `/tools/best-time-to-post`, `/tools/best-time-to-post/[platform]` — all confirmed rendering real content on prod (WebFetch verified).
- All four pages set `robots: { index: true, follow: true }` explicitly in `generateMetadata`.
- Handle checker: JSON-LD `WebApplication` schema at `src/app/tools/handle-checker/page.tsx:52`, canonical URL set, OG tags wired.
- Best-time platform pages: `force-static` + `generateStaticParams` — pre-rendered at build time for all 7 platforms. Good for Core Web Vitals and crawl budget.
- CTAs confirmed live: `/tools/handle-checker` has "See a preview plan → /start" and "Sign up free → /signup" at the bottom section. `/tools/best-time-to-post/x` has "Get posting times optimized for YOUR audience → /start" and "Sign up → /signup".
- The `/start` page is a no-auth preview funnel (paste handle → 7-post plan in 30s), which is a strong value-delivery CTA for a cold visitor.

### What is broken / missing

1. **No sitemap.xml.** There is no `src/app/sitemap.ts` file and no `public/sitemap.xml`. The prod `GET /sitemap.xml` returned 404 (confirmed via WebFetch). Google cannot discover the tool pages via sitemap — it must crawl links. This is a meaningful SEO gap for acquisition pages targeting "best time to post on X" and "social handle checker."
   - Fix: create `src/app/sitemap.ts` emitting at minimum: `/`, `/pricing`, `/tools`, `/tools/handle-checker`, `/tools/best-time-to-post`, and all 7 platform slugs from `TOOL_PLATFORMS`. 30-minute task.

2. **No robots.txt.** `GET /robots.txt` returned 404. Without a robots.txt, crawlers apply defaults. The app pages (`/dashboard`, `/queue`, etc.) have `noindex` set in metadata, but no `Disallow` in robots.txt means crawlers still burn budget fetching them before discarding. More importantly, no `Sitemap:` directive means Google has one less discovery signal.
   - Fix: create `src/app/robots.ts` with `Allow: /`, `Disallow: /api/`, `Disallow: /connect/`, and `Sitemap: <siteUrl>/sitemap.xml`.

3. **Tool CTAs send traffic to `/start` or `/signup` with no UTM source tag.** The conversion path from a free tool to a signup is invisible — no way to know which tool drives signups. Adding `?utm_source=tools&utm_medium=cta&utm_campaign=handle-checker` (or `best-time`) to the `href="/start"` and `href="/signup"` links in each tool page costs nothing and makes the funnel measurable.
   - Files: `src/app/tools/best-time-to-post/shell.tsx:108` (`/start` link), `src/app/tools/handle-checker/page.tsx:186,192` (`/start` and `/signup` links), `src/app/tools/page.tsx:85` (`SignupCta` → `/start`).
   - Confirmed by live WebFetch: zero tracking params on any signup/CTA link.

4. **`/tools/best-time-to-post` hub page footer only links back to itself** — the `ToolShell` footer at `src/app/tools/best-time-to-post/shell.tsx:63` has "Best time to post" but not "Handle checker." A visitor on the best-time hub cannot navigate to the handle checker tool without going through the nav. The `/tools` hub is not linked in the footer at all. Low reach impact but easy to fix.

### Verdict: PARTIAL — pages are live, indexed (metadata correct), and CTAs are present, but no sitemap, no robots.txt, and no UTM tracking mean the loop is unobservable and under-discovered.

---

## Loop 3: Referral Loop

### What is live

- `src/lib/growth/referrals.ts` — full referral engine: code minting, ref-cookie capture through email-confirm round trip, workspace attribution on creation, vesting on first post, anti-farming guard (reward withheld until referred workspace ships first post).
- Invite link displayed and copyable at `/settings/referrals` — page includes `CopyInviteLink`, `ShareModule` (X intent + copy-to-clipboard), and per-referral vesting stats.
- The `ShareModule` has pre-written "build in public" copy and a one-click "Share on X" intent button — well-suited for the wedge ICP.
- Vesting is wired into both publish choke-points (`queue/actions.ts:975`, `post-scheduled/route.ts:285`), so the reward fires automatically on first post.
- The referral cookie survives the Supabase email-confirm round trip via HTTP-only `mm_ref` cookie — technically sound.
- Incentive: +5 bonus posts/month to the referrer per vested referral (50% of the 10-post Hobby ceiling), credited forever.

### What is broken / missing

1. **The share moment is buried at `/settings/referrals` — three clicks deep.** The path is: header → Settings icon → Settings sub-nav → "Refer & earn." There is no referral nudge on the dashboard, no post-publish prompt ("You just posted — invite a founder friend to earn 5 bonus posts/month"), and no onboarding step. The ICP (solo founders building in public) is highly share-prone immediately after publishing for the first time — that moment is completely unaddressed.
   - Fix: add a dismissible `ReferralNudgeCard` to `src/app/(app)/dashboard/page.tsx` (already has activation-card slots) that surfaces after the first post is published. Copy: "You shipped your first post. Share marketingmagic with a founder friend — you'll both earn bonus posts." Link → `/settings/referrals`.

2. **Referral page is not linked anywhere in the main app nav.** The only path is through `/settings/referrals` in the settings sub-nav (`src/app/(app)/settings/layout.tsx:22`). There is no "Invite friends" or "Refer & earn" link in `AppHeader` or the main navigation for Hobby users. Most users will never find it organically.
   - Fix: add a "Refer & earn" link to the app header's user-menu dropdown (already exists for settings/billing) — visible only for Hobby plan users. 10-line change in `src/components/app-header.tsx`.

3. **The referral reward (5 posts/month) is opaque.** The `ShareModule` default copy says "Here's a free week" for the referred user but no copy quantifies what the referrer earns from the referral until they reach `/settings/referrals`. A user who hasn't visited that page doesn't know the mechanic, so there's no pull.
   - Fix: surface the incentive at the moment it vests — on first-post publish, toast/banner: "Your friend used your link and just posted — +5 posts/month added to your plan."

4. **No new-signup referral capture for `?ref=post` from the attribution badge.** The attribution badge appends `?ref=post` (the string `"post"`, not a user's referral code) to the site URL. A visitor who clicks that link and signs up does NOT trigger `setPendingRefCookie` — the code checks for a 6–16 alphanumeric code, and `"post"` matches `REF_PARAM_RE` but `referral_codes` has no row with `code = "post"`. So the attribution badge clickthrough creates a signup that is measured as direct, not as a PLG-driven referral. This is by design (it's brand attribution, not a referral), but the gap is that there is no way to count how many signups the badge actually drove.
   - Fix: treat `ref=post` as a special analytics tag on the homepage and `/signup` (log a `posthog` / Vercel Analytics event `{ event: "attribution_signup", source: "badge" }` when a user signs up with `ref=post` in search params).

### Verdict: PARTIAL — the full referral engine is correctly built (code mint, cookie, vesting, reward), but the loop is invisible in the product. Almost no users will find `/settings/referrals` organically, and the first-post "aha moment" — the best time to prompt a share — has zero referral surfacing.

---

## Top-5 Ranked Fix List

| Rank | Fix | Impact | Effort | File(s) |
|------|-----|--------|--------|---------|
| 1 | **Gate attribution removal behind an upgrade prompt** | Every Hobby user who wants the badge off now sees a paid conversion moment instead of a silent toggle. Retains billboarding for the entire free tier. | Low (20 lines) | `src/app/(app)/settings/referrals/referral-controls.tsx:151–158` — replace "Turn off" button with upgrade Link when `isHobby` |
| 2 | **Add sitemap.ts + robots.ts** | Makes all 9+ tool pages discoverable by Google via sitemap; removes crawl budget waste on private routes; adds Sitemap directive. Direct SEO uplift for the top-of-funnel acquisition surface. | Low (40 lines total) | New `src/app/sitemap.ts` + `src/app/robots.ts` |
| 3 | **Surface a referral nudge at first-post publish** | Activates the referral loop at the highest-intent moment (the user just published = they're happy). Current UX leaves +5 posts/month on the table for every user who never discovers `/settings/referrals`. | Medium (1 new card component + dashboard wiring) | `src/app/(app)/dashboard/page.tsx`, new `src/app/(app)/dashboard/referral-nudge-card.tsx` |
| 4 | **Add UTM params to all tool-page CTAs** | Makes the free-tools → signup conversion funnel observable. Zero behavior change, pure measurement. Without this, you cannot validate that SEO investment is working. | Low (3 files, 5 link edits) | `src/app/tools/best-time-to-post/shell.tsx:108`, `src/app/tools/handle-checker/page.tsx:186,192`, `src/app/tools/page.tsx:85` |
| 5 | **Track attribution badge clickthroughs** | Closes the measurement gap on Loop 1. Without it, `ref=post` clicks are invisible in analytics and you cannot size the loop's contribution to signups. | Low (homepage `searchParams` read + one analytics call) | `src/app/page.tsx` — read `searchParams.ref === "post"` + emit `track({ stage: "attribution_click" })` |

---

## Single Highest-Leverage Fix

**Gate attribution removal behind a paid upgrade (Rank 1).** Every Hobby user who currently hits the toggle can kill the most compounding PLG surface in one click — for free. The fix is 20 lines: swap the "Turn off" button for a pricing link. This turns the settings page from an anti-loop into a conversion moment, retains billboarding across the whole free tier, and costs nothing.
