# Tasks — Marketingmagic Roadmap

Generated from CEO review on 2026-05-13. Update status inline as work progresses.

**Status legend:** `TODO` · `IN_PROGRESS` · `BLOCKED` · `DONE` · `DEFERRED`

---

## Phase 1 — Voice Wedge (Approach A, ~4 weeks)

Sharpen the voice fidelity so plan-generated drafts sound like the customer, not like generic AI.

- [DONE 2026-05-13] **Voice ingestion schema** — add `voice_profile` JSONB column to `brand_briefs` (vocabulary, openers, sentence length, formality, do-not-say). Migration `006_voice_profile.sql`.
- [DONE 2026-05-13] **Voice ingestion UI** — extend `/settings/brief` with a "Reference posts" section; users paste 5-20 existing posts. Server action triggers extraction.
- [DONE 2026-05-13] **Voice extraction prompt** — Claude call that turns reference posts into structured `voice_profile`.
- [DONE 2026-05-13] **Voice-aware generation** — plan generator prompt injects `voice_profile`; output includes per-post `voice_score` (0-100) in the same JSON response.
- [DONE 2026-05-13] **Auto-regenerate low scores** — drafts with `voice_score < 70` regenerate (max 2 retries); ship best-of-3 with `low_confidence` flag if still below threshold.
- [DONE 2026-05-13] **Rejection reason capture** — `/queue` reject action prompts for reason (off-voice / wrong-theme / factually-wrong / other).
- [DONE 2026-05-13] **Rejection feedback loop** — accumulated reasons surface in next plan regen prompt as "avoid these patterns."
- [DONE 2026-05-13] **Voice profile evolution** — weekly cron consolidates rejection reasons into `voice_profile` updates (proposes diff, user accepts).

## Phase 1.5 — Magic Moment Onboarding (~1 week, stacks on Phase 1)

**Added 2026-05-13 (10x Expansion #1).** Pre-signup activation flow: paste your handle, see your voice profile + preview plan in 30 seconds.

- [DONE 2026-05-13] **Landing-page handle entry form** — `/start` page, unauthenticated; channel selector + handle + optional niche + optional paste-fallback textarea.
- [DONE 2026-05-13] **Public post scraping** (Bluesky real; X/LinkedIn/IG/Threads paste-only) — Bluesky uses `app.bsky.feed.getAuthorFeed` (genuinely public, no auth). X/LinkedIn/IG/Threads public APIs require OAuth or paid access; documented `UsePasteFallbackError` path is the V1 primary for those channels. (24h cache deferred — token IS the cache.)
- [DONE 2026-05-13] **Reuse Phase 1 voice extraction prompt** — synthetic Brief shape calls existing `generatePlan` which already feeds `reference_posts` to Claude (the Phase 1 voice mechanism in this codebase). No new prompt.
- [DONE 2026-05-13] **Preview plan generation** — `previewPlan()` wraps `generatePlan` with weeks=1, slices to ≤7 posts as a teaser.
- [DONE 2026-05-13] **Tokenized preview URL** — `/preview/[token]`; HMAC-SHA256 with `CRON_SECRET`; 24h TTL; no DB; expired/bad-sig tokens get a graceful recovery view.
- [DONE 2026-05-13] **Anti-abuse** — in-memory per-IP rate limit (5/hour). hCaptcha punted to follow-up (would require new env vars + a script in landing form). Rate limit is documented as not-Vercel-cold-start-tight; swap to Upstash when abuse is observed.
- [DONE 2026-05-13] **Cold-profile fallback** — Bluesky scrapes returning <10 posts surface a friendly paste prompt with the textarea revealed; paste paths with <10 posts re-prompt for more.
- [DONE 2026-05-13] **Signup conversion analytics** — structured server-side funnel events (`landing_view`, `landing_submit`, `scrape_success`, `scrape_fallback`, `preview_generated`, `preview_view`, `preview_rate_limited`, `preview_cold_profile`, `preview_signup_cta_click`) emitted as single-line JSON; client-side Vercel Analytics `track('mm_preview_signup_cta', ...)` fires on CTA click; signup link carries `?from=preview&t=` for the joinable funnel.
- [TODO] **Sequencing gate** — only ship after Phase 1 voice scoring is dogfood-validated; bad preview = brand damage. **(Deployment gate, owned by main thread — left intentionally as TODO.)**

## Phase 2 — Cross-Channel Adaptation (Approach A, ~2 weeks)

One "post idea" → channel-tuned variants. One approval cascades.

- [TODO] **`idea_id` FK on posts** — nullable, groups variants. Migration `007_post_idea.sql`.
- [TODO] **Multi-variant generator** — plan generator returns N channel variants per idea with `skip_channels` support for unfit channels.
- [TODO] **`/queue` idea grouping UI** — collapsible row per idea with per-channel variant inside.
- [TODO] **"Approve all variants" action** — single click, with per-variant edit/approve still available.
- [TODO] **Per-channel character/format rules** — enforced at generation time (X 280, LinkedIn 3k, IG caption 2200).

## Phase 2.1 — Reverse-Plan from a Content Goal (~1 week)

**Added 2026-05-13 (10x Expansion #13, promoted to early sequence by user request).** Customer states goal + timeline + constraints; we generate a strategy, then a plan reverse-engineered to hit it. Two-step gate (approve strategy, then approve posts). Repositions the product from "AI scheduler" to "AI strategist."

- [TODO] **`content_goals` table** — `workspace_id`, `goal_text`, `goal_metric` (followers / inbound / launch_date / credibility / recovery / custom), `target_value`, `target_date`, `status`, `baseline_snapshot` JSONB, `created_at`. Migration `006a_content_goals.sql` (renumber as needed).
- [TODO] **`/goals/new` UI** — structured questionnaire; default "vague goal" mode where Claude proposes the strategy; sophisticated users edit strategy directly.
- [TODO] **Reverse-planner prompt** — Claude takes `goal` + `voice_profile` + `channel_mix` → returns strategy outline (theme weights, posting cadence, milestone narrative) → derives 4-12 weeks of posts.
- [TODO] **Two-step approval flow** — strategy preview page approves first; plan generation runs only after strategy commit.
- [TODO] **Goal-realism gate** — reverse-planner returns "this goal is unrealistic; closest achievable goal is X" rather than silently failing.
- [TODO] **Goal progress dashboard widget** — actual vs target, baseline-comparison framing ("grew 312 vs baseline 89/month") to keep attribution honest.
- [TODO] **Mid-course replan triggers** — week-2 + week-4 automatic check; proposes plan modification if behind goal; user confirms.
- [TODO] **Per-post goal anchoring** — every post stores `goal_id` FK; dashboards can roll engagement up to the goal level.
- [TODO] **Cross-channel adaptation integration** — generated posts go through Phase 2 multi-channel variant generator.

## Phase 2.5 — Source-to-Posts Ingestion (~2 weeks)

**Added 2026-05-13 (10x Expansion #2).** Customer pastes a URL or uploads a file; we extract themes/quotes and generate a content cluster anchored to that source.

- [DONE 2026-05-14] **`sources` table** — `id`, `workspace_id`, `source_url` or `file_path`, `kind` (html/youtube/podcast/pdf/transcript), `extracted_summary`, `extracted_quotes` JSONB, `created_at`. Migration `009_sources.sql`. Adds `posts.source_id` FK so analytics can roll engagement up to the source.
- [DONE 2026-05-14] **`/sources` UI** — paste URL or paste text; list view + detail view show extracted summary/themes/quotes/facts; "Generate cluster" CTA on detail.
- [PARTIAL 2026-05-14] **URL fetcher + readability** — Rolled a tiny strip-HTML extractor with SSRF guard (`src/lib/sources/extract-html.ts`); skipped Mozilla Readability + linkedom deps. Flag in commit: marketing-style noisy pages may need the readability dep added later. robots.txt is NOT honored (matches the existing brief extractor behavior); paywall detection limited to "page has <200 chars readable content" fallback.
- [PARTIAL 2026-05-14] **YouTube/podcast transcript** — Groq Whisper helper shipped at `src/lib/sources/transcribe.ts` behind `GROQ_API_KEY`. Audio-download path (yt-dlp / ffmpeg) is NOT wired — V1 punts YouTube to a "paste the transcript" path. The transcribe helper is ready for Phase 2.6 Founder-Mode file uploads.
- [PARTIAL 2026-05-14] **PDF parsing** — Punted on adding pdf-parse + pdfjs-dist deps. `.pdf` URLs return a friendly "paste the text instead" message via `src/lib/sources/extract-pdf.ts`. Reachable in Phase 3 video pipeline kick-off.
- [DONE 2026-05-14] **Extraction prompt** — `src/lib/sources/extract-claude.ts` uses claude-sonnet-4-6 tool-use forcing to return structured themes + verbatim quotes + facts + summary JSON (zod re-validated).
- [DONE 2026-05-14] **Source-anchored generator** — `src/lib/sources/generate-from-source.ts` wraps the standard plan generator with a `source` field on `PlanGenInputs`; `src/lib/plan/prompt.ts` adds a "## Source material (anchor every idea in this)" block. Each post stores `source_id` FK on insert.
- [DONE 2026-05-14] **Dashboard: source-attribution** — `getSourceLeaderboard()` + dashboard "Top source-anchored posts (30d)" section. Cold-start (no metrics yet) hides the section entirely.
- [DONE 2026-05-14] **"You own/have rights" checkbox** + ToS update — required checkbox on `/sources/new`; submission blocked when unchecked. ToS update is a separate doc task left for main thread.
- [DONE 2026-05-14] **Cold-source fallback** — `ColdSourceError` thrown when text <200 chars; UI surfaces "Paste at least 200 words, or try a different source."

## Phase 2.6 — Founder Mode (~1 week, stacks on 2.5)

**Added 2026-05-13 (10x Expansion #4).** Record a voice memo, get a week of posts in your voice across channels. Mobile-first UX, premium tier anchor.

- [TODO] **`/record` page** — mobile-responsive, big record button, MediaRecorder API; PWA-installable.
- [TODO] **Whisper transcription** — reuses Phase 2.5 Groq Whisper infra.
- [TODO] **Tap-to-edit transcript pass** — user fixes mis-heard product names / jargon before generation.
- [TODO] **"Generate week of posts" templated source flow** — opinionated single-button entry into Phase 2.5 pipeline + Phase 2 cross-channel adaptation.
- [TODO] **Verbatim-quote preservation** — generator prompt instructed to retain customer's exact phrases as hooks where natural.
- [TODO] **Privacy policy update** — raw audio retention policy (default delete after transcription); opt-in to keep for voice profile training.
- [TODO] **New "Founder" pricing tier** — Stripe price + product update; higher post quota, exclusive Founder Mode access, higher monthly price.
- [TODO] **Pricing page redesign** — three tiers (Solo / Agency / Founder); Founder tier positioning emphasizes "no typing, voice-only workflow."
- [TODO] **Mobile design polish budget** — 2 days reserved; this feature is brand-defining when it looks Granola-grade and brand-damaging when it looks like a dashboard.

## Phase 3 — Full Video Pipeline (~4 weeks)

Upload, transcode, caption, schedule, post. No AI generation.

- [BLOCKED-DECISION] **Transcoding target** — Supabase Storage + Fly.io ffmpeg worker, or managed (Mux/Cloudinary)?
- [BLOCKED-DECISION] **TikTok hold** — accept uploads now and queue for when partner API access lands, or block uploads to TikTok entirely?
- [TODO] **`post_media` schema extension** — add `video` kind with `duration_s`, `width`, `height`, `codec`, `variants` (JSONB array of transcoded URLs).
- [TODO] **Upload UI on `/queue`** — drag-drop video, show client-side validation (size/length), live progress.
- [TODO] **ffmpeg worker** — re-encode to H.264; generate 9:16 / 1:1 / 16:9 variants. Resilient to retries.
- [TODO] **Whisper captions (Groq)** — auto-generate, user-editable, persisted as `post.caption_track`.
- [TODO] **Thumbnail selection** — extract 5 evenly-spaced frames; UI lets user pick.
- [BLOCKED-EXTERNAL] **Meta Graph App Review** — submit `instagram_content_publish` scope (2-4 week review). **Start week 1, don't wait.**
- [TODO] **IG Reels publish** via Meta Graph (handle 60-min upload-URL expiry in state machine).
- [TODO] **Threads video publish** via Meta Graph.
- [TODO] **X chunked video upload** — INIT/APPEND/FINALIZE protocol, separate from existing image path.
- [TODO] **Bluesky video publish** — 60s/100MB limit, ATproto blob upload.

## Phase 4 — Self-Serve Growth (Approach B, ~2 weeks)

Unblock onboarding so customers can sign up without manual hand-holding.

- [DONE 2026-05-13] **X 3-legged OAuth flow** at `/api/oauth/x/initiate` + callback. Replace manual-paste creds UI.
- [DONE 2026-05-13] **Existing user migration path** — manual-paste users prompted to re-auth via OAuth.
- [DONE 2026-05-14] **`/settings/team` page** — invite by email, assign role (owner/editor/viewer).
- [DONE 2026-05-14] **Memberships RLS audit** — verify every business-table policy honors membership, not just `owner_id`.
- [DONE 2026-05-14] **Multi-workspace switcher UX** — agency users with 5+ workspaces need fast switching + a "switch to" search.

## Phase 4.5 — Reply Inbox + Engagement Assistant (~3 weeks)

**Added 2026-05-13 (10x Expansion #3).** Unified inbox for replies/comments/mentions across channels, with voice-aware draft replies. Draft-only, never auto-send.

- [BLOCKED-EXTERNAL] **Meta Graph App Review for messaging scopes** (`instagram_manage_comments`, etc.) — start week 1, parallel track.
- [TODO] **`interactions` table** — unified schema for replies/mentions/DMs/comments. Columns: `id`, `workspace_id`, `social_account_id`, `channel`, `external_id`, `parent_post_id` (nullable), `author_handle`, `body`, `received_at`, `status` (unread/read/replied/snoozed), `priority_score`. Migration `010_interactions.sql`.
- [TODO] **Per-channel poller crons** — X replies/mentions every 15min; IG/Threads/LinkedIn hourly; Bluesky every 15min.
- [TODO] **Priority scoring** — signals: verified author, follower count, customer-list match, question-detection, age.
- [TODO] **`/inbox` UI** — unified timeline, channel/priority/age filters, keyboard navigation, draft+send.
- [TODO] **Voice-aware reply drafter** — Claude prompt that takes voice_profile + thread context → 1-2 draft replies.
- [TODO] **Send via per-channel reply API** — `xReply`, `instagramComment`, `threadsReply`, `blueskyReply`, `linkedinReply` helpers.
- [TODO] **Native-reply conflict handling** — if user replied natively before we synced, mark our draft stale.
- [TODO] **Engagement-debt dashboard card** — "X unanswered, Y over 24h."
- [TODO] **Replies-as-sources integration** — high-engagement replies auto-suggested as `sources` (Phase 2.5 integration).
- [TODO] **Hard rule: no auto-send** — even with trust mode, replies require explicit click. Documented in code + UI.

## Phase 4.6 — Multi-Client Dashboard (~3 days)

**Added 2026-05-13 (10x Expansion #5 — lightweight version).** Cross-workspace KPI rollup + fast switcher for users who already manage multiple workspaces. No Stripe refactor, no white-label, no client portal. Full Agency Mode (Phase 7) gated on signing ≥1 agency design partner.

- [DONE 2026-05-13] **`/portfolio` page** — single page showing all of user's workspaces' top KPIs (posts shipped, approval rate, top theme, engagement trend) side-by-side.
- [DONE 2026-05-13] **Per-workspace drill-down** — clicking a workspace card opens its `/dashboard` in same tab.
- [DONE 2026-05-13] **Fast switcher (cmd-K)** — keyboard shortcut to switch between workspaces; fuzzy-search by workspace name.
- [DONE 2026-05-13] **Cross-workspace alerts** — "Workspace X has 8 pending approvals over 24h"; shows on `/portfolio`.

## Phase 7 — Full Agency Mode (CONTINGENT)

**Added 2026-05-13 (deferred, partner-gated).** Full white-label / multi-client / org-billing platform. **Do not start until ≥1 agency design partner commits (verbal or paid).**

- [BLOCKED-EXTERNAL] **Design partner signed** — prerequisite before any work begins.
- [DEFERRED] `organizations` table + `organization_memberships` schema.
- [DEFERRED] Stripe billing refactor — organization-level subscription, per-client tier pricing.
- [DEFERRED] Client-facing portal — `/client/[token]` magic-link auth, view + approve only.
- [DEFERRED] White-label — logo / primary color / subdomain (`acme.marketingmagic.com`).
- [DEFERRED] Monthly client report PDF generator — agency-branded, posts + engagement + theme winners.
- [DEFERRED] Client onboarding flow — agency invites client, client OAuths their own channels.
- [DEFERRED] RLS audit — security-critical; full review of every business-table policy under org-level membership.

## Phase 5 — LinkedIn End-to-End (personal-first)

**Decision (2026-05-13):** Ship personal profile posting first via `w_member_social` (generally available). Apply for `w_organization_social` (company-page) in parallel; integrate when approval lands.

- [DONE 2026-05-13] **LinkedIn 3-legged OAuth** — `/api/oauth/linkedin/initiate` + callback already partially exists; finish the flow with `w_member_social` scope.
- [DONE 2026-05-13] **Personal-profile posting** end-to-end test against a real account; verify `linkedinPost` helper works against real API.
- [DONE 2026-05-13] **LinkedIn metrics pull** — add to hourly `/api/cron/pull-metrics` (UGC API for personal posts).
- [TODO] **Long-form variant** in cross-channel adaptation (Phase 2 integration).
- [BLOCKED-EXTERNAL] **Marketing Developer Program application** for `w_organization_social` — start week 1, parallel track. Indefinite timeline.
- [TODO] **Company-page posting** (gated on the above; UI shows "coming soon" until approval lands).

## Phase 6 — Experimentation (theme-level deep + sequential-variants light)

**Decision (2026-05-13):** Option D — theme-level cohort analysis as the honest centerpiece, "Quick Experiments" sequential variants as a lighter labeled-as-directional feature. Cross-workspace experimentation deferred until agency customers exist.

### 6A — Theme-level (honest, slow signal)
- [TODO] **`/analytics/themes` page** — engagement-rate distribution per theme over rolling 28-day window, vs workspace baseline.
- [TODO] **"Winning themes" report** — surfaces themes with statistically meaningful lift (Bayesian credible interval over per-post engagement rate).
- [TODO] **KPI-weighted regen integration** — plan regen pulls top/bottom theme list (already exists in primitive form; promote to first-class).
- [TODO] **Decay-aware ranking** — recent post performance weighted higher than 6-week-old data.

### 6B — Quick Experiments (sequential variants, directional labeling)
- [TODO] **`post_variants` table** — `variant_id`, `parent_post_id`, `experiment_id`, `allocation_weight`. Migration `008_experiments.sql`.
- [TODO] **Variant generation UI** — `/queue` item gets "Run Quick Experiment" action; plan generator produces 2-3 variants for the flagged idea.
- [TODO] **Sequential scheduling** — variants posted across distinct time slots (≥48h apart, same day-of-week ideally).
- [TODO] **Winner declaration** — after both variants have ≥48h of metrics, show observed lift with explicit **"directional, not statistically rigorous"** banner.
- [TODO] **Quick Experiments dashboard card** — active experiments + completed-with-winner list.

### 6C — Cross-workspace (deferred)
- [DEFERRED] **Cross-workspace experiments** — revisit once Phase 4 ships *and* we have agency users running ≥5 comparable accounts.

---

## Phase 4.7 — Discord Integration (~3-4 days)

**Added 2026-05-13 (10x Expansion #7 — Discord only).** Approve-from-anywhere via Discord bot. Slack deferred; Discord is the right channel for indie/creator/community brands.

- [DONE 2026-05-14] **Discord bot OAuth + install flow** — `/integrations/discord` page; install bot to server; scope: bot + applications.commands.
- [DONE 2026-05-14] **`integrations` table** — `workspace_id`, `provider`, `target_channel_id`, `auth_payload` (encrypted), `event_filters`. Migration `011_integrations.sql`.
- [DONE 2026-05-14] **Daily digest dispatch** — share payload pipeline with existing email-digest cron; new transport adapter. Email + Discord run independently in the same cron — one transport failing never breaks the other.
- [DONE 2026-05-14] **Interactive Components (buttons)** — approve/edit/reject buttons on per-post embeds. Custom IDs HMAC-signed with EMAIL_LINK_SECRET, 48h UTC-day bucket so they survive midnight rollover.
- [DONE 2026-05-14] **Slash commands** — `/mm queue` shows pending; `/mm stats` shows today's KPIs; `/mm pause` pauses trust-mode posting. Global registration via `POST /api/integrations/discord/commands` (cron-secret auth).
- [DONE 2026-05-14] **Action handler endpoint** — `/api/integrations/discord/action`; verify Ed25519 signature (Node built-in crypto.verify, no tweetnacl); perform action; edit message in-place via UPDATE_MESSAGE response.
- [DONE 2026-05-14] **Threading discipline** — daily digest as one parent message; per-post embeds with buttons in a 24h auto-archive thread. Channel stays quiet.
- [DONE 2026-05-14] **Per-event configuration UI** — workspace picks digest / realtime / alerts-only via checkbox form on `/integrations/discord`. `alerts_only` reserved (not wired yet).
- [PARTIAL] **Multi-member attribution** — each Discord-user-action records the Discord username + user id in `approvals.diff`. User_id still maps to workspace owner (no Discord→Supabase membership table yet); follow-up work to link Discord accounts to real members.
- [DEFERRED] **Slack integration** — revisit when first agency/marketing-team customer asks.

## Phase 6.5 — Smart Timing / Optimal Posting Windows (~1 week)

**Added 2026-05-13 (10x Expansion #6).** Data-driven per-channel scheduling using each workspace's own engagement-rate-by-time data, with industry-baseline fallback for cold-start.

- [DONE 2026-05-14] **Time-slot analysis function** — per-channel engagement-rate distribution over hour-of-day × day-of-week buckets (2-hour windows); Bayesian smoothing toward baseline for sparse slots. *Implemented in `src/lib/timing/analyze.ts` (prior weight 5, 90d window).*
- [DONE 2026-05-14] **Decay weighting** — recent data weighted higher; share the decay function with Phase 6A theme analytics. *`src/lib/timing/decay.ts` — exponential decay, 30d half-life.*
- [DONE 2026-05-14] **Industry-baseline fallback dataset** — public-research-derived defaults per channel × category for cold-start workspaces. *`src/lib/timing/baselines.ts` — Sprout/Hootsuite/Later 2024 baselines per channel × day × 2h.*
- [N/A] **Magic Moment Onboarding integration** — *Magic Moment's public scraping is too thin to feed per-slot engagement estimates (no per-post impression data). Revisit when scraping gains depth or when a public engagement API becomes available.*
- [DONE 2026-05-14] **Per-channel optimal windows API** — top 3-5 slots per channel per workspace, with confidence levels. *`getOptimalWindows(workspaceId, channel)` returns `OptimalWindowsResult` with `top[]` + `grid[]` + confidence labels.*
- [DONE 2026-05-14] **Plan generator integration** — `suggested_scheduled_at` defaults to next-available optimal window. *`src/app/(app)/plans/new/actions.ts` groups variants by channel, fetches `getOptimalWindows` once per channel in parallel, sorts variants by Claude's suggested time, then walks each channel assigning the next-future optimal slot via `nextOptimalSlotIso` (with a per-channel +2h cursor so two variants never collide). Stamps `generation_metadata.timing_source` as `'optimal' | 'baseline' | 'claude_suggested'`.*
- [DONE 2026-05-14] **Trust-mode integration** — auto-scheduled posts go to optimal windows by default; manual override always honored. *Cold-start fallback in `plans/new/actions.ts`: when a post is trusted (auto-scheduled) AND the channel's top window is baseline-only (no observed high-confidence data yet), we revert to Claude's `suggested_scheduled_at` and mark `timing_source: 'claude_suggested'`. Non-trusted posts still get the baseline-optimal slot since the user reviews them anyway.*
- [DONE 2026-05-14] **Dashboard "Best Windows" widget** — visual heatmap per channel with confidence shading. *`src/app/(app)/dashboard/best-windows-widget.tsx` — 7×12 heatmap + top-3 list with confidence pills, baseline-only chip when no observed posts.*
- [DONE 2026-05-14] **Per-post timing explainer** — UI shows "Why this time? +X% engagement vs your previous slot." *`src/app/(app)/plans/[id]/post-timing-explainer.tsx` — four tones (success/warning/default/muted) based on lift-vs-average.*
- [DONE 2026-05-14] **Workspace timezone setting** — explicit `audience_timezone` field; default to owner TZ; user-toggleable. *Stored on `brand_briefs.audience_timezone` (migration 012, default 'UTC'); UI at `src/app/(app)/settings/brief/timezone-section.tsx`.*

## Phase 6.6 — Competitor Watch (~2 weeks, Founder-tier gated)

**Added 2026-05-13 (10x Expansion #8).** Per-workspace watch list of competitor handles. Daily pulls + weekly pattern digest. High-performing competitor posts feed Phase 2.5 source pipeline as opt-in inspiration. Premium-gated to manage API rate exposure + anchor pricing.

- [TODO] **`watch_handles` table** — `workspace_id`, `channel`, `handle`, `added_at`, `last_pulled_at`, `status` (active / failed / rate_limited). Migration `012_competitor_watch.sql`.
- [TODO] **`/competitors` UI** — add/remove handles, recent winners feed, "use as source" action per post.
- [TODO] **Daily pull cron** — extends `/api/cron/pull-metrics`; per-workspace competitor sync; rate-budget-aware (queue + backoff).
- [TODO] **Initial backfill** — when handle added, pull last 30 days in single sync; gracefully partial-fail on rate limits.
- [TODO] **Outlier detection per handle** — engagement-rate vs that account's own baseline; flag top 10% as "winners."
- [TODO] **Pattern extraction (Claude)** — for each winner, return tags (vulnerability / list / contrarian / data-driven / question / etc.) + 1-line "possible reason."
- [TODO] **Weekly competitor digest** — email + Discord transports (reuse Phase 4.7 dispatcher).
- [TODO] **Counter-content trigger** — "draft response" action on a winner; pre-fills source ingestion with competitor's post.
- [TODO] **Stripe tier gating** — Founder-tier subscribers only; UI shows upgrade CTA for lower tiers.
- [TODO] **API rate budgeting** — global rate caps per channel; per-workspace cap derived from tier; observability on rate-limit hits.
- [TODO] **Anti-harassment guardrails** — no "draft a takedown of @X" flow; system prompt refuses adversarial framings; Claude safety as second line.

## Phase 6.7 — "Why This Post Wins" Learning Cards (~3 days)

**Added 2026-05-13 (10x Expansion #9).** Per-post explainer cards for outliers (above-or-below ±50% baseline) using Smart Timing + theme analytics + voice profile + post metrics. Honest epistemics ("Possible reasons:"). Save-to-playbook action.

- [TODO] **Outlier-trigger logic** — fires for posts ≥48h old with engagement ±50% from baseline.
- [TODO] **Constrained explainer prompt** — Claude returns 3-5 bullets, each mapped to specific data points (theme tag, hour, opener type, length). No free-form speculation.
- [TODO] **Card UI** — collapsible on dashboard + post-detail; max 2 cards per dashboard view; "Possible reasons:" framing.
- [TODO] **"Save pattern to playbook" action** — starred patterns flow into future plan-generation prompts as preferred patterns.
- [TODO] **`playbook_patterns` table** — `workspace_id`, `pattern_kind`, `pattern_data` JSONB, `saved_at`. Migration `013_playbook.sql`.
- [TODO] **Underperformer card** — same UI for posts below baseline; tone-checked phrasing to avoid being demoralizing.

## Phase 6.8 — Auto-Thread Builder, X-only (~3-4 days)

**Added 2026-05-13 (10x Expansion #10).** Long-form input → properly-structured X thread. Voice-aware hook + close, per-tweet edit, single approval gate, sequential posting with `in_reply_to_tweet_id` chaining. Threads-the-platform deferred.

- [TODO] **Thread-aware generator prompt** — Claude returns structured `[{tweet_number, text, role}]` JSON; validates char counts, hook <200 chars, close has CTA.
- [TODO] **`/queue` thread UI** — single approval row, stacked tweets, per-tweet inline edit, "regenerate hook only" button.
- [TODO] **`xPost` extension** — `xPostThread(tweets[])` chains `in_reply_to_tweet_id`; 1-2s delay between tweets to avoid rate limits.
- [TODO] **Partial-publish state** — DB tracks per-tweet posted status; UI shows "3 of 10 posted, retry?" on partial failures.
- [TODO] **Thread-roll-up metrics** — `post_metrics` aggregates across the thread; per-tweet sub-metrics in detail view.
- [TODO] **Founder Mode integration** — voice-memo generations of >800 words auto-suggest "Make this an X thread."
- [DEFERRED] **Threads-the-platform threading** — revisit when Threads grows or customer asks.

## Phase 6.9 — Theme-Aware Calendar Gaps (~3 days)

**Added 2026-05-13 (10x Expansion #11).** Proactive surfacing of high-performing themes that have gone dormant. Dashboard widget + digest integration + one-click regen.

- [TODO] **Daily gap-detection cron** — computes per-workspace theme × `days_since_last_post` × lifetime engagement-rate quartile.
- [TODO] **Threshold logic** — flag theme as "neglected" when engagement-rank is top quartile AND days_since_last_post > 14.
- [TODO] **`/dashboard` "Neglected Themes" widget** — sortable list; per-theme "regenerate 2-3 posts" action.
- [TODO] **Digest integration** — Discord (Phase 4.7) + email — top 1-2 neglected themes surface in daily digest when present; suppressed when no gaps.
- [TODO] **One-click regen action** — pre-fills plan generator with `theme: X, count: 2-3, schedule: optimal-windows-only`; drops into approval queue.
- [TODO] **Snooze / archive controls** — per-theme "snooze 30 days" or "archive theme" affordance so customers can intentionally drop themes without being nagged.
- [TODO] **Opt-out per workspace** — gap-detection on by default; settings toggle to disable.

## Phase 6.10 — Hashtag Intelligence (~1 week)

**Added 2026-05-13 (10x Expansion #12).** Per-channel hashtag recommendations driven by workspace history + competitor-watch tag winners + channel-specific best practices. Recommendation-only, never auto-applied.

- [TODO] **`hashtag_usage` table** — `workspace_id`, `channel`, `tag`, `post_id`, `engagement_at_post`, `recorded_at`. Migration `014_hashtag_usage.sql`.
- [TODO] **Backfill cron** — one-time scan of historical posts to extract hashtag usage.
- [TODO] **Channel-specific rules** — X: 0-1 tag; LinkedIn: 3 tags; IG: 8-15 mixed-tier; Threads: 1-2; Bluesky: 0-1.
- [TODO] **Recommendation prompt** — Claude takes draft + workspace tag history + competitor-tag winners → ranked 3-5 suggestions per channel.
- [TODO] **Competitor tag harvest** — daily cron pulls top hashtags from Phase 6.6 competitor winners; recency-weighted (14-day window).
- [TODO] **`/queue` hashtag pill UI** — pre-checked recommendations under each draft; one-click add/remove; channel-specific cap enforced.
- [TODO] **Channel-aware UI copy** — X UI explicitly explains "0-1 tags recommended on X — algorithm penalizes spam."
- [TODO] **Cold-start blend** — workspaces with <20 historical posts blend with channel best-practice defaults.

## Open Decisions

- [RESOLVED 2026-05-13] LinkedIn surface — personal-first via `w_member_social`; company-page via parallel application.
- [RESOLVED 2026-05-13] A/B test dimension — theme-level deep + sequential-variants light; cross-workspace deferred.
- [DEFERRED 2026-05-13] Q6+Q7 video infra (transcoding target + TikTok holding pattern) — revisit closer to Phase 3 kickoff. Phases 1-2 ship first, infra decision made with sharper requirements.

## Deferred (revisit after Phases 1-6 land)

- AI video generation (Veo / Sora / Kling) — wait for cost drop or paying customer ask
- Voice cloning fine-tune (per-workspace model)
- Multi-language
- KMS rotation for `social_accounts.credentials`
- Auto-archive of drafts older than 14 days
- Competitor monitoring / scraping
- Reply / DM management inbox

## Done

See `git log --oneline` for the V0/V1/V2 baseline (plan generator, approval queue, dashboard, event ingestion, trust mode, Stripe billing, multi-channel dispatch, image gen, email digest, onboarding wizard, UI/UX polish).
