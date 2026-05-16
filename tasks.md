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

## Phase 2 — Cross-Channel Adaptation (Approach A, ~2 weeks) — DONE

One "post idea" → channel-tuned variants. One approval cascades.

- [DONE 2026-05-13] **`idea_id` FK on posts** — nullable, groups variants. Migration `007_post_idea.sql:21-28`. Type `IdeaId` at `src/lib/db/types.ts:328`. Commit `b0b27df` (V3-xc-1).
- [DONE 2026-05-14] **Multi-variant generator** — `planVariantSchema` with explicit `skip` + rationale per variant at `src/lib/plan/schema.ts:18-53`; idea→variants fan-out at `:58-63`; consumed and skip-filtered at `src/app/(app)/plans/new/actions.ts:238-254` (fresh `crypto.randomUUID()` `idea_id` per idea).
- [DONE 2026-05-14] **`/queue` idea grouping UI** — `byIdea` grouping at `src/app/(app)/queue/page.tsx:238-255`; collapsible `QueueIdeaRow` at `src/app/(app)/queue/queue-row.tsx:424-428`; legacy null-idea rows still render as `QueueRow`.
- [DONE 2026-05-14] **"Approve all variants" action** — `approveAllVariantsAction(ideaId)` at `src/app/(app)/queue/actions.ts:63-110` (workspace-scoped, only flips `pending_approval`→`scheduled`, per-variant audit rows). Wired at `queue-row.tsx:462-464` with pending-count label; per-variant edit/approve still works alongside it.
- [DONE 2026-05-14] **Per-channel character/format rules** — caps in `src/lib/channels/registry.ts:37,53,70,88,104` (X 280, LinkedIn 3000, Threads 500, IG 2200, Bluesky 300); enforced via `channelCapsBlock()` prompt block at `src/lib/plan/prompt.ts:204-205`, tool-schema `MAX_TEXT` upper bound at `schema.ts:8`, and `superRefine` per-variant at `schema.ts:42-52`.

## Phase 2.1 — Reverse-Plan from a Content Goal (~1 week)

**Added 2026-05-13 (10x Expansion #13, promoted to early sequence by user request).** Customer states goal + timeline + constraints; we generate a strategy, then a plan reverse-engineered to hit it. Two-step gate (approve strategy, then approve posts). Repositions the product from "AI scheduler" to "AI strategist."

- [DONE 2026-05-15] **`content_goals` table** — Migration `supabase/migrations/018_content_goals.sql:30-87` covers `workspace_id`, `goal_text`, `goal_metric` (CHECK enum at `:42-48`), `target_value`, `target_date`, `status` (CHECK enum at `:63-69`), `baseline_snapshot` JSONB, `strategy` JSONB, timestamps. RLS via `is_workspace_member` at `:97-105`. Trigger `set_updated_at` at `:93-95`. Type rows added at `src/lib/db/types.ts:404-441`.
- [DONE 2026-05-15] **`/goals/new` UI** — Structured questionnaire (metric dropdown + target value + target date + free-form goal text) at `src/app/(app)/goals/new/page.tsx` + `goal-form.tsx`. Server action `proposeStrategyAction` at `src/app/(app)/goals/new/actions.ts:29-129` calls `proposeStrategy()` and persists the draft row. Sophisticated-edit path deferred (V1 surfaces a closest-achievable counter-offer via the realism gate; "Edit (start over)" link routes back to `/goals/new`).
- [DONE 2026-05-15] **Reverse-planner prompt** — `proposeStrategy()` at `src/lib/goals/reverse-plan.ts:223-263` calls claude-sonnet-4-6 with tool-use forcing. Reads goal + voice_profile + channel_mix and returns structured `GoalStrategy` (theme_weights, posting_cadence, milestones 4–12 weeks, success_criteria, risks). zod re-validation via `proposeStrategyResultSchema` at `src/lib/goals/schema.ts:122-140`. Plan derivation runs in `generatePostsFromGoal()` at `src/lib/goals/generate-plan.ts:88-110`.
- [DONE 2026-05-15] **Two-step approval flow** — Step 1 `/goals/new` persists `content_goals` row with `status='draft'` and strategy JSONB (`src/app/(app)/goals/new/actions.ts:118-129`). Step 2 `/goals/[id]/page.tsx:230-250` renders the "Approve & generate plan" button only when draft; `generatePostsAction` at `src/app/(app)/goals/[id]/actions.ts:75-313` runs the planner, persists posts, then flips status to `active`.
- [DONE 2026-05-15] **Goal-realism gate** — Tool schema's discriminated union at `src/lib/goals/reverse-plan.ts:55-90` forces Claude to commit `realistic:true|false`. When `false`, Claude returns `reason` + `closest_achievable` strategy (same shape) and the preview page surfaces a warning banner at `src/app/(app)/goals/[id]/page.tsx:138-156`. The user can still approve the downsized plan (never silently inflated).
- [DONE 2026-05-15] **Goal progress dashboard widget** — `src/app/(app)/dashboard/goal-progress-widget.tsx` mounted between Quick Experiments and Best Windows. `computeGoalProgress()` at `src/lib/goals/progress.ts` branches by metric: followers/inbound fall back to qualitative posts-toward-target (no V1 follower-snapshot table); launch_date renders days-remaining; credibility/recovery/custom track posts-against-strategy milestones. Pace verdict with ±5% band. Cap-3 visible; hides when no active goals.
- [DONE 2026-05-15] **Mid-course replan triggers** — `src/lib/goals/replan-check.ts` walks active goals, gates on age ≥14d + 7-day throttle via `replan_proposals` (migration 020). Daily cron at `/api/cron/goal-replan-check/route.ts` + `.github/workflows/cron-goal-replan-check.yml` (12:00 UTC). Widget surfaces "Plan is behind — propose new strategy?" CTA routing to `/goals/[id]?replan=1`. Replan UI itself is the deferred follow-up.
- [DONE 2026-05-15] **Per-post goal anchoring** — `posts.goal_id` nullable FK added in migration `018_content_goals.sql:118-127` with partial index. `Posts.Row/Insert/Update` extended at `src/lib/db/types.ts:333-401`. Every post inserted via `generatePostsAction` carries `goal_id` at `src/app/(app)/goals/[id]/actions.ts:284`.
- [DONE 2026-05-15] **Cross-channel adaptation integration** — `generatePostsFromGoal()` at `src/lib/goals/generate-plan.ts:113-133` is a thin wrapper around `generatePlan()`, so the existing Phase 2 multi-variant pipeline (idea→variants fan-out, voice scoring, per-channel caps) runs unchanged. The persistence flatMap at `src/app/(app)/goals/[id]/actions.ts:239-309` mirrors `/plans/new/actions.ts:238-254` exactly.

## Phase 2.5 — Source-to-Posts Ingestion (~2 weeks)

**Added 2026-05-13 (10x Expansion #2).** Customer pastes a URL or uploads a file; we extract themes/quotes and generate a content cluster anchored to that source.

- [DONE 2026-05-14] **`sources` table** — `id`, `workspace_id`, `source_url` or `file_path`, `kind` (html/youtube/podcast/pdf/transcript), `extracted_summary`, `extracted_quotes` JSONB, `created_at`. Migration `009_sources.sql`. Adds `posts.source_id` FK so analytics can roll engagement up to the source.
- [DONE 2026-05-14] **`/sources` UI** — paste URL or paste text; list view + detail view show extracted summary/themes/quotes/facts; "Generate cluster" CTA on detail.
- [DONE 2026-05-15] **URL fetcher + readability** — `src/lib/sources/extract-html.ts` now runs `@mozilla/readability` via `linkedom` as the primary article-extraction path with the regex `stripHtml()` pipeline as fallback for JS-heavy / malformed pages. Title preference: Readability > `<h1>` > `<title>` > URL slug. SSRF guard unchanged.
- [DEFERRED 2026-05-15] **YouTube/podcast transcript** — yt-dlp + ffmpeg are native binaries that don't run on Vercel serverless. Punted to Phase 3 (Full Video Pipeline) where the ffmpeg worker decision is the same one. Groq Whisper helper at `src/lib/sources/transcribe.ts` remains usable for the Phase 2.6 Founder-Mode browser-recorder path. Paste-the-transcript stays the V1 YouTube entry point.
- [DONE 2026-05-15] **PDF parsing** — `src/lib/sources/extract-pdf.ts` uses `pdf-parse` v2 (`PDFParse`) with a 20 MB cap; `fetch.ts` now routes `.pdf` URLs through `fetchPdfSource()` and emits `kind="pdf"`. Falls into the existing `ColdSourceError` path when <200 chars come back (scanned/image-only PDFs).
- [DONE 2026-05-14] **Extraction prompt** — `src/lib/sources/extract-claude.ts` uses claude-sonnet-4-6 tool-use forcing to return structured themes + verbatim quotes + facts + summary JSON (zod re-validated).
- [DONE 2026-05-14] **Source-anchored generator** — `src/lib/sources/generate-from-source.ts` wraps the standard plan generator with a `source` field on `PlanGenInputs`; `src/lib/plan/prompt.ts` adds a "## Source material (anchor every idea in this)" block. Each post stores `source_id` FK on insert.
- [DONE 2026-05-14] **Dashboard: source-attribution** — `getSourceLeaderboard()` + dashboard "Top source-anchored posts (30d)" section. Cold-start (no metrics yet) hides the section entirely.
- [DONE 2026-05-14] **"You own/have rights" checkbox** + ToS update — required checkbox on `/sources/new`; submission blocked when unchecked. ToS update is a separate doc task left for main thread.
- [DONE 2026-05-14] **Cold-source fallback** — `ColdSourceError` thrown when text <200 chars; UI surfaces "Paste at least 200 words, or try a different source."

## Phase 2.6 — Founder Mode (~1 week, stacks on 2.5)

**Added 2026-05-13 (10x Expansion #4).** Record a voice memo, get a week of posts in your voice across channels. Mobile-first UX, premium tier anchor.

- [DONE 2026-05-14] **`/record` page** — `src/app/record/page.tsx` (server gates on `hasFounderMode()`) + `record-client.tsx` (MediaRecorder 5-state FSM, MIME negotiation for Chromium/Safari, cleanup on unmount). PWA-installable via `/manifest.webmanifest` with `start_url=/record`. Commit `16b59e4`.
- [DONE 2026-05-14] **Whisper transcription** — `transcribeRecordingAction` re-checks founder gate server-side, optionally uploads to `founder-audio` Storage bucket BEFORE Groq, 20 MB cap. Reuses `src/lib/sources/transcribe.ts` Groq helper. Commit `16b59e4`.
- [TODO] **Tap-to-edit transcript pass** — user fixes mis-heard product names / jargon before generation. (Transcript preview is read-only on main; tap-to-edit lives on worktree branch `agent-aa6c9084a0f518594`, not yet merged.)
- [TODO] **"Generate week of posts" templated source flow** — opinionated single-button entry into Phase 2.5 pipeline + Phase 2 cross-channel adaptation. (Slice 2.6/3 on worktree branch.)
- [TODO] **Verbatim-quote preservation** — generator prompt instructed to retain customer's exact phrases as hooks where natural.
- [DONE 2026-05-14] **Privacy policy update** — `brand_briefs.keep_raw_audio` (default false; migration 015); founder-audio bucket configured private with 90d lifecycle + workspace-prefix RLS. Default deletes audio after transcription; opt-in keeps. Commit `2e421f2`.
- [DONE 2026-05-14] **New "Founder" pricing tier** — `PlanId` now includes `'founder'` ($149/mo, 500 posts, 200 image gens); `STRIPE_PRICE_FOUNDER` env wired through `planForPriceId`; `hasFounderMode()` / `hasCompetitorWatch()` gates available. Commit `2e421f2`.
- [DONE 2026-05-15] **Pricing page redesign** — three paid tiers (Solo / Agency / Founder) as a 3-col centerpiece grid, Founder gets an amber border + "Voice-only workflow" pill so it reads as the anchor tier. Hobby demoted to a quieter "or stay free" card below. `pro` enum id preserved → `name: "Solo"` for display only, so existing Stripe subscriptions and DB rows keep working without a data migration. Cherry-picked from worktree commit `fb5004d`; the audio-cleanup cron from that commit was dropped (depends on voice-memo storage helpers from worktree slices 2.6/1 + 2.6/2 that aren't on main — main's per-request cleanup in `transcribeRecordingAction` already covers the retention contract).
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
- [DONE 2026-05-15] **Long-form variant** in cross-channel adaptation — `linkedinLongFormBlock()` at `src/lib/plan/prompt.ts:265-286` instructs Claude to use 800–2500 chars on LinkedIn when the idea has substance (thesis, story, multiple supporting points). Stays <600 chars when the idea is one-beat; explicit "don't pad" guidance. Phase 2.1 (Goals) + Phase 2.5 (Sources) pick it up transparently through the shared `generatePlan()` call site. Schema unchanged — guidance lives in the prompt, not as a hard zod refinement.
- [BLOCKED-EXTERNAL] **Marketing Developer Program application** for `w_organization_social` — start week 1, parallel track. Indefinite timeline.
- [TODO] **Company-page posting** (gated on the above; UI shows "coming soon" until approval lands).

## Phase 6 — Experimentation (theme-level deep + sequential-variants light)

**Decision (2026-05-13):** Option D — theme-level cohort analysis as the honest centerpiece, "Quick Experiments" sequential variants as a lighter labeled-as-directional feature. Cross-workspace experimentation deferred until agency customers exist.

### 6A — Theme-level (honest, slow signal)
- [DONE 2026-05-15] **`/analytics/themes` page** — engagement-rate distribution per theme over rolling 28-day window, vs workspace baseline. `src/app/(app)/analytics/themes/page.tsx:1-138`; computation in `src/lib/analytics/themes.ts:43-228`.
- [DONE 2026-05-15] **"Winning themes" report** — surfaces themes with statistically meaningful lift (Bayesian Beta-Binomial shrinkage with 50-effective-sample prior; 80% credible interval verdict in `src/lib/analytics/themes.ts:188-216`). Winner/loser badges in the table rendered by `src/app/(app)/analytics/themes/page.tsx:121-138`.
- [DONE 2026-05-15] **KPI-weighted regen integration** — `loadThemeWinners()` in `src/lib/analytics/themes.ts:339` feeds the new `themeWinners` field on `PlanGenInputs` (`src/lib/plan/prompt.ts:75`); rendered as a "## Themes that have been working" block via `themeWinnersBlock` (`src/lib/plan/prompt.ts:121-137`), wired into the system prompt at `src/lib/plan/prompt.ts:296`. Wired into all four generator call sites: `src/app/(app)/plans/new/actions.ts:117-125` + 173, `src/app/(app)/dashboard/actions.ts:108-113` + 133, `src/app/(app)/goals/[id]/actions.ts:171-176` + 193, `src/app/(app)/sources/[id]/actions.ts:118-123` + 141.
- [DONE 2026-05-15] **Decay-aware ranking** — `src/lib/analytics/themes.ts` imports `decayWeightFor` from `src/lib/timing/decay.ts:25`; both engagement and impressions are decay-weighted before posterior computation (`themes.ts:120-145`). 30-day half-life shared with Smart Timing.

### 6B — Quick Experiments (sequential variants, directional labeling)
- [DONE 2026-05-15] **`post_variants` table** — `supabase/migrations/019_post_variants.sql` (note: the spec text referred to `008_experiments.sql` — actual filename is 019, since 008 was already taken by Phase 6.7 `playbook_patterns`). Creates `experiments` + `post_variants` with RLS via `is_workspace_member`. Types added to `src/lib/db/types.ts:788-844`.
- [DONE 2026-05-15] **Variant generation UI** — "Run Quick Experiment" button in `src/app/(app)/queue/queue-row.tsx:448-460` (scheduled rows only, suppressed on experiment variants). Server action `runQuickExperimentAction` in `src/app/(app)/queue/actions.ts:450-510`. Variant generator: `src/lib/experiments/generate.ts:175-225` (Claude tool call producing N variants with hook + rationale).
- [DONE 2026-05-15] **Sequential scheduling** — `pickSlots()` in `src/lib/experiments/run.ts:148-184` uses `getOptimalWindows()` + `nextOptimalSlotIso()` with a hard 48h cursor spacing; falls back to +48/+96/+144h offsets when no Smart Timing data. Variants land as `pending_approval` so the user reviews each in the queue before they ship.
- [DONE 2026-05-15] **Winner declaration** — `evaluateExperiment()` in `src/lib/experiments/winner.ts:96-181`; gates on every variant having ≥48h of `posted_at` age, requires ≥10% lift over the parent to declare. Always returns `directional: true` + the `DIRECTIONAL_BANNER` copy (`src/lib/experiments/winner.ts:28-29`).
- [DONE 2026-05-15] **Quick Experiments dashboard card** — `src/app/(app)/dashboard/quick-experiments-widget.tsx:36-58` (server component; caps at 5 active + completed-with-winner rows; hides entirely when empty). Wired into `src/app/(app)/dashboard/page.tsx:194` between the Neglected Themes and Best Windows widgets.

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
- [DONE 2026-05-15] **Multi-member attribution** — `discord_links` join table (workspace_id, discord_user_id → member_user_id; RLS-guarded self-link). Discord action handler looks up the actor in `discord_links` and attributes `approvals.user_id` to the real Supabase user, falling back to the workspace owner only on miss. First miss per user fires an ephemeral follow-up with a signed 7-day link-claim URL (`/integrations/discord/link?token=…`) so the *next* approval attributes correctly. Migration `017_discord_links.sql`. *Commit hash applied at merge.*
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

> **MERGE NOTE (2026-05-15, RESOLVED):** the `phase-6.6-competitor-watch` branch shipped its migration at slot 016 (`016_competitor_watch.sql`), colliding with main's applied `016_fix_rls_recursion.sql`. On merge, the competitor-watch migration was **renumbered to `supabase/migrations/021_competitor_watch.sql`** and applied via `supabase db push --linked`. Main's 015/016 stay authoritative; the branch's own `015_founder_audio.sql` was NOT copied (main's is canonical). Verify with `supabase migration list --linked`.

- [DONE 2026-05-15] **`watch_handles` table** — `workspace_id`, `channel`, `handle`, `added_at`, `last_pulled_at`, `status` (active / failed / rate_limited / paused). *Migration `supabase/migrations/021_competitor_watch.sql:42` defines the table with `is_workspace_member` RLS, normalised handles (lowercase, no `@`), `(workspace_id, channel, handle)` unique index, and `(workspace_id, status, last_pulled_at)` cron-order index. Renumbered from the branch's 016 to avoid collision with main's `016_fix_rls_recursion.sql`.*
- [DONE 2026-05-15] **`/competitors` UI** — add/remove handles, recent winners feed, "use as source" action per post. *`src/app/(app)/competitors/page.tsx:1` renders the watch list + recent winners with channel badges, status chips, and a "Draft response" button per winner. `src/app/(app)/competitors/add/page.tsx` + `add-handle-form.tsx` host the add flow. Founder-tier short-circuits to an upgrade CTA pointed at `/settings/billing`. Header link surfaced in `src/components/app-header.tsx:33` via `hasCompetitorWatch(active.plan)` so non-Founder users never see it.*
- [DONE 2026-05-15] **Daily pull cron** — per-workspace competitor sync; rate-budget-aware (queue + backoff). *`src/app/api/cron/competitor-watch/route.ts:67` is a standalone POST route (not folded into `/api/cron/pull-metrics`) so the rate-budget loop can manage its own per-channel counters without touching post-metric semantics. Triggered daily 12:00 UTC by `.github/workflows/cron-competitor-watch.yml`, Bearer `CRON_SECRET` auth, processes handles ordered by `last_pulled_at asc` so oldest gets priority when caps hit.*
- [DONE 2026-05-15] **Initial backfill** — when handle added, pull last 30 days in single sync; gracefully partial-fail on rate limits. *Implemented as a first-pull bump inside the daily cron: `src/app/api/cron/competitor-watch/route.ts:213` switches to `BACKFILL_POSTS_PER_HANDLE=100` (vs 30 on subsequent runs) when `row.last_pulled_at == null`. Picks up next 12:00 UTC tick. Rate-limit hits flag the row `rate_limited` and the next run retries — no partial-state book-keeping needed.*
- [DONE 2026-05-15] **Outlier detection per handle** — engagement-rate vs that account's own baseline; flag top 10% as "winners." *`src/lib/competitors/detect-outliers.ts:31` (`flagOutliers`) is a pure function over a 90-day window for one handle. Requires `MIN_POSTS_FOR_BASELINE=8` before flagging anything; cutoff is `ceil(rankedCount × 0.10)` clamped ≥1. `computeEngagementRate()` prefers impressions-normalised when present, else raw counts (percentile does the cross-handle normalising).*
- [DONE 2026-05-15] **Pattern extraction (Claude)** — for each winner, return tags + 1-line "possible reason." *`src/lib/competitors/extract-pattern.ts:99` (`extractCompetitorPattern`) uses `claude-sonnet-4-6` tool-use forcing on `submit_competitor_pattern`. Tags are constrained to a closed vocabulary (`COMPETITOR_PATTERN_TAGS` in `src/lib/competitors/schema.ts:97` — 13 tags: vulnerability/list/contrarian/data-driven/question/story/how-to/announcement/controversial-take/behind-the-scenes/humor/quote/thread-starter). Cached per row in `pattern_tags`/`pattern_reason`; never re-extracted. Cron only calls Claude for newly-flagged winners with `pattern_tags IS NULL`.*
- [DONE 2026-05-15] **Weekly competitor digest** — email + Discord transports. *`src/lib/competitors/digest.ts:32` (`buildAndDispatchWeeklyDigest`) dispatched from the daily cron at `src/app/api/cron/competitor-watch/route.ts:147` when `now.getUTCDay() === 0` (Sunday) OR `?digest=force`. Reuses Phase 4.7 Discord `sendMessage()` (`src/lib/integrations/discord.ts:137`) and Resend HTTP API; respects `event_filters.digest` per integration. Suppresses entirely on zero winners — silence is the right default.*
- [DONE 2026-05-15] **Counter-content trigger** — "draft response" action on a winner; pre-fills source ingestion with competitor's post. *`src/app/(app)/competitors/actions.ts:97` (`useWinnerAsSourceAction`) seeds a `sources` row with `source_kind='transcript'` containing the winner text + pattern reason + an explicit "build on / respond to this idea constructively. Do not attack the author" frame. Marks `competitor_posts.drafted_at` so the UI dims the button. Hands off to `/sources/[id]` — user explicitly triggers cluster generation from there, giving them a chance to edit the seed before Claude touches it.*
- [DONE 2026-05-15] **Stripe tier gating** — Founder-tier subscribers only; UI shows upgrade CTA for lower tiers. *`src/lib/billing/feature-gates.ts:18` (`isCompetitorWatchEnabled`) delegates to `hasCompetitorWatch()` in `src/lib/billing/tiers.ts:114` (Phase 2.6 alignment — the canonical Founder-tier gate). `/competitors` + `/competitors/add` + every server action re-check defensively; non-Founder workspaces see the upgrade CTA pointing at `/settings/billing`. Header nav is hidden entirely via `hasCompetitorWatch(active.plan)` in `src/components/app-header.tsx`.*
- [DONE 2026-05-15] **API rate budgeting** — global rate caps per channel; per-workspace cap derived from tier; observability on rate-limit hits. *`GLOBAL_RATE_CAP_PER_15MIN` in `src/lib/billing/feature-gates.ts:33` (x: 100, bluesky: 300, others: 0). Cron loop in `src/app/api/cron/competitor-watch/route.ts:107` decrements per-channel counter and short-circuits when remaining ≤ 0 — those rows are marked `rate_limited` with `reason='channel_budget_exhausted'` for observability. `rateLimitHits` array returned in the response body so the next run / dashboard can see which channel/handle pairs hit the cap.*
- [DONE 2026-05-15] **Anti-harassment guardrails** — no "draft a takedown of @X" flow; system prompt refuses adversarial framings; Claude safety as second line. *Three layers, intentional defence-in-depth: (1) UI has no surface for adversarial actions (no follow/DM/quote-tweet/takedown). (2) `useWinnerAsSourceAction` constructs the source seed with explicit "build on or respond constructively. Do not attack the author." text; `src/app/(app)/competitors/add/add-handle-form.tsx:97` shows the same promise to the user. (3) `src/lib/competitors/extract-pattern.ts:71` (`buildSystem()`) hard-codes "describe the POST, not the author. Never adversarial." and forbids naming the handle in the reason. Claude's own safety policy is the fourth-line guardrail.*

## Phase 6.7 — "Why This Post Wins" Learning Cards (~3 days)

**Added 2026-05-13 (10x Expansion #9).** Per-post explainer cards for outliers (above-or-below ±50% baseline) using Smart Timing + theme analytics + voice profile + post metrics. Honest epistemics ("Possible reasons:"). Save-to-playbook action.

- [DONE 2026-05-14] **Outlier-trigger logic** — fires for posts ≥48h old with engagement ±50% from baseline. *`src/lib/explain/outliers.ts` — 28d median baseline (robust to a single viral pull), 1.5×/0.5× thresholds, 48h age gate, ≥4-sample minimum to suppress noisy calls on cold workspaces. Sorted by `|log(ratio)|` so the most informative outliers surface first.*
- [DONE 2026-05-14] **Constrained explainer prompt** — Claude returns 3-5 bullets, each mapped to specific data points (theme tag, hour, opener type, length). No free-form speculation. *`src/lib/explain/extract.ts` uses claude-sonnet-4-6 tool-use forcing (`submit_explainer`) with a closed `kind` enum (theme/timing/voice/opener/length/other). Deterministic signals (opener classification, in-recommended-window flag, theme lift ratio, workspace winner median chars) are computed in `buildSignals()` and passed into the prompt so Claude only ranks evidence — never speculates. zod re-validates 3-5 reasons + hedged phrasing rules.*
- [DONE 2026-05-14] **Card UI** — collapsible on dashboard + post-detail; max 2 cards per dashboard view; "Possible reasons:" framing. *`src/components/why-this-wins-card.tsx` renders the collapsible card; `src/app/(app)/dashboard/explain-section.tsx` caps at 2 via `loadDashboardExplainerCards(workspaceId, 2)` and renders nothing on empty (cleaner than a placeholder); `src/app/(app)/plans/[id]/page.tsx:122` mounts a per-post card on plan-detail. Eyebrow copy "Possible reasons, never certainties." sets the epistemic frame.*
- [DONE 2026-05-14] **"Save pattern to playbook" action** — starred patterns flow into future plan-generation prompts as preferred patterns. *`savePatternAction` in `src/app/(app)/plans/[id]/actions.ts:30` inserts via the service client (RLS allows workspace members). Plan generator picks them up in `src/app/(app)/plans/new/actions.ts:116` (`loadRecentPatterns` runs in parallel with theme signals / rejections / hashtag suggestions) and `src/lib/plan/prompt.ts:253` renders the "Preferred patterns from your saved playbook" block verbatim into the system prompt.*
- [DONE 2026-05-14] **`playbook_patterns` table** — `workspace_id`, `pattern_kind`, `pattern_data` JSONB, `saved_at`. *Shipped as `supabase/migrations/008_playbook.sql`, not the originally-numbered `013_playbook.sql` (migrations are sequential, not aligned to phase numbers). Migration also adds `posts.explainer jsonb` as a 1:1 cache so the dashboard renders without a second join and we never re-call Claude for the same outlier. RLS on `playbook_patterns` via `is_workspace_member`; `pattern_kind` kept as text (not enum) so new kinds don't require migrations.*
- [DONE 2026-05-14] **Underperformer card** — same UI for posts below baseline; tone-checked phrasing to avoid being demoralizing. *Same `WhyThisWinsCard` component, verdict-driven via `verdictStyles()` — amber tint, "Softer than your baseline — X% of your baseline" label, ratio shown as a percentage rather than a multiplier. Save-pattern affordance is hidden for underperformers (you don't save what you don't want to repeat); replaced with the line "Use this as a note, not a verdict — engagement varies week to week." The Claude system prompt branches on verdict and bans words like "failed/bad/poor" for the underperformer tone.*

## Phase 6.8 — Auto-Thread Builder, X-only (~3-4 days)

**Added 2026-05-13 (10x Expansion #10).** Long-form input → properly-structured X thread. Voice-aware hook + close, per-tweet edit, single approval gate, sequential posting with `in_reply_to_tweet_id` chaining. Threads-the-platform deferred.

- [DONE 2026-05-14] **Thread-aware generator prompt** — `src/lib/threads/generate.ts` (`generateThread()`) uses claude-sonnet-4-6 tool-use forcing (`submit_thread`) to return structured `[{tweet_number, text, role}]` JSON; zod re-validates 3-25 tweets, hook ≤200 chars, body+close ≤280, strict 1..N sequence, hook/body/close role discipline. Voice-aware when `voice_profile` is supplied.
- [DONE 2026-05-14] **`/queue` thread UI** — `src/components/thread-builder-ui.tsx` (`ThreadBuilderRow` + `ThreadTweetEditor`). Single "Approve thread" button on the collapsible header, per-tweet inline edit (Textarea + char counter, hook tightened to 200), "Regenerate hook" calls Claude with the rest of the thread as context so the new hook still leads into tweet 2. Hashtag chip slots are intentionally skipped on thread tweets (X threads = no hashtags).
- [DONE 2026-05-14] **`xPost` extension** — `xPostThread(creds, tweets[], {startInReplyTo, delayMs})` in `src/lib/social/x.ts` chains `in_reply_to_tweet_id` sequentially with a 1.2s delay (configurable 800-5000ms); returns `{tweetIds[], lastError?}` on mid-thread failure. `xPost()` itself gained an optional `inReplyToTweetId` param.
- [DONE 2026-05-14] **Partial-publish state** — `src/lib/threads/post.ts` (`postThread()`) reconciles against `social_posts_ledger` before any X call (handles the crash-after-X-before-DB-update window), then posts the unposted tail using the previous tweet's `external_id` as `startInReplyTo`. On partial failure marks the failing row + every later row `status='failed'` with `failure_reason='thread interrupted at tweet N of M: <reason>'`. `/queue` surfaces "X of N posted — retry remaining (M)" via `retryPartialThreadAction` which re-arms the failed rows back to `scheduled`; the next cron tick (or the same one if rows are already past their scheduled_at) resumes the thread idempotently.
- [DONE 2026-05-14] **Thread-roll-up metrics** — `src/lib/threads/metrics.ts` (`rollupThreadMetrics()`) aggregates `post_metrics` across thread rows: impressions = max (hook is sticky, summing double-counts), likes/replies/reposts/clicks = sum, engagement_rate computed on the aggregates. Per-tweet breakdown returned in `perTweet[]` for the detail view. Wiring into dashboard widgets deferred until first thread is posted.
- [DEFERRED 2026-05-14] **Founder Mode integration** — Phase 2.6 Founder Mode hasn't landed yet (`src/lib/voice-memo/*` does not exist). Will wire the >800-word voice-memo → "Make this an X thread" auto-suggest once Phase 2.6 merges; the thread builder API (`generateThread({ sourceText, voiceProfile, ctaHint })`) is ready to consume the transcript as `sourceText` with zero plumbing changes.
- [DEFERRED] **Threads-the-platform threading** — revisit when Threads grows or customer asks.

## Phase 6.9 — Theme-Aware Calendar Gaps (~3 days)

**Added 2026-05-13 (10x Expansion #11).** Proactive surfacing of high-performing themes that have gone dormant. Dashboard widget + digest integration + one-click regen.

- [DONE 2026-05-14] **Daily gap-detection cron** — computes per-workspace theme × `days_since_last_post` × lifetime engagement-rate quartile.
- [DONE 2026-05-14] **Threshold logic** — flag theme as "neglected" when engagement-rank is top quartile AND days_since_last_post > 14.
- [DONE 2026-05-14] **`/dashboard` "Neglected Themes" widget** — sortable list; per-theme "regenerate 2-3 posts" action.
- [DONE 2026-05-14] **Digest integration** — Discord (Phase 4.7) + email — top 1-2 neglected themes surface in daily digest when present; suppressed when no gaps.
- [DONE 2026-05-14] **One-click regen action** — pre-fills plan generator with `theme: X, count: 2-3, schedule: optimal-windows-only`; drops into approval queue.
- [DONE 2026-05-14] **Snooze / archive controls** — per-theme "snooze 30 days" or "archive theme" affordance so customers can intentionally drop themes without being nagged.
- [DONE 2026-05-14] **Opt-out per workspace** — gap-detection on by default; settings toggle to disable.

## Phase 6.10 — Hashtag Intelligence (~1 week)

**Added 2026-05-13 (10x Expansion #12).** Per-channel hashtag recommendations driven by workspace history + competitor-watch tag winners + channel-specific best practices. Recommendation-only, never auto-applied.

- [DONE 2026-05-14] **`hashtag_usage` table** — Migration `014_hashtag_usage.sql`; unique (post_id, tag); index (workspace_id, channel, recorded_at desc); RLS via `is_workspace_member`; CHECK enforces normalized (lowercase, no leading #) tags. *Implemented at `supabase/migrations/014_hashtag_usage.sql`.*
- [DONE 2026-05-14] **Backfill cron** — admin endpoint `POST /api/admin/backfill-hashtags` (CRON_SECRET-auth) walks every workspace × bulk-upserts with ignoreDuplicates. Plus per-batch backfill on every new plan insert via `backfillHashtagsForPosts()` so freshly-generated drafts get logged without an explicit cron run. *Implemented at `src/lib/hashtags/backfill.ts` + `src/app/api/admin/backfill-hashtags/route.ts`.*
- [DONE 2026-05-14] **Channel-specific rules** — `getChannelHashtagPolicy(channel)` in `src/lib/hashtags/rules.ts`: X 0–1, LinkedIn 3 (exactly), Threads 1–2, IG 8–15, Bluesky 0 (showChips=false). Single source of truth — recommender, /queue UI, and prompt block all read from it.
- [DONE 2026-05-14] **Recommendation pipeline** — `src/lib/hashtags/recommend.ts` is purely data-driven (no Claude call per post). Bayesian-shrunk recency-weighted engagement over 90-day window; 30-day exponential decay half life; per-channel cap applied. Plan generator gets a Map<ChannelId, string[]> hint via the new `recommendedHashtagsBlock()` in `src/lib/plan/prompt.ts`. *Claude call deferred — workspace history + channel defaults are sufficient signal and free.*
- [DEFERRED 2026-05-14] **Competitor tag harvest** — depends on Phase 6.6 Competitor Watch (not yet shipped). The `hashtag_usage` schema already supports it (nullable `post_id`, channel-keyed) so when 6.6 lands, the daily cron only needs to insert with `post_id=NULL` and a synthetic `engagement_at_post`. Recommender will pick it up unchanged. *Phase 6.6 must ship first.*
- [DONE 2026-05-14] **`/queue` hashtag pill UI** — `src/components/hashtag-pill-row.tsx` renders pre-checked chips below the draft text; one-click toggle; channel cap enforced inline and on the server via `setPostHashtagsAction`. Suggestions are server-rendered via `src/app/(app)/queue/hashtag-suggestions-server.tsx` and slotted into `QueueRow` so the client surface stays clean.
- [DONE 2026-05-14] **Channel-aware UI copy** — every channel's policy returns a `notes` string explaining the rule. X: "0–1 hashtags — the algorithm penalizes spammy tag stacks. Default is no tag." Bluesky: chips hidden, replaced with "Hashtags off: Bluesky's culture and algorithm both reward plain prose." X also forces zero pre-checked tags regardless of suggestions.
- [DONE 2026-05-14] **Cold-start blend** — workspaces with <20 historical posts × channel blend in `COLD_START_SEEDS` at neutral confidence. Reason badge `channel_default` distinguishes seeds from observed winners in the chip tooltip.

## Cleanup notes

- [DEFERRED 2026-05-15] **Ghost workspaces from RLS-recursion era** — 8 `pitch-pit*` rows accumulated in the user's account when migration 010 broke `listWorkspaces()` (inserts succeeded but SELECT silently failed). Migration 016 unblocked visibility; they now show in the switcher. Need either a one-off cleanup script or a UI delete-workspace affordance (cascades through brand_briefs, posts, social_accounts via FK ON DELETE CASCADE). Defer until either (a) a real customer asks for workspace deletion, or (b) the cosmetic clutter motivates a 30-minute Supabase Studio cleanup.

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
