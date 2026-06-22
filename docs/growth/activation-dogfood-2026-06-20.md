# Activation Dogfood — 2026-06-20

## Environment

- **Tested against:** PROD — `https://marketingmagic.vercel.app`
- **Harness:** `scripts/dogfood/bootstrap-session.mjs` + `lib.mjs` (Playwright Chromium, service-role throwaway user, no real OAuth)
- **Throwaway user:** `e2e+dogfood-mqlw4uib@marketingmagic-tests.local` — deleted by `cleanup.mjs` (confirmed, no errors)
- **Scripts run:** `bootstrap-session`, `run-activation-batch-verify` (pre+post), `seed-queue-data`, `run-activation-verify`, plus two custom walk scripts
- **Screenshots:** `/tmp/mm-dogfood/` (local only; not committed)

---

## Step-by-step walkthrough

### 0. Homepage (`/`)

**Status: OK** — loads cleanly. Title correct: "marketingmagic — build in public without becoming a full-time poster". CTAs present: "Sign up free", "Try it free", "See a preview plan — 30s, no signup" → `/start`.

The `/start` no-signup preview flow works: 7 form inputs, "Show me my preview plan" CTA visible. This is a good cold-traffic entry point.

### 1. Signup (`/signup`)

**Status: OK (works as designed)** — the page renders a real email+password form when unauthenticated. The dogfood browser was already authed so the server redirected to `/dashboard` — that redirect is correct behaviour, not a bug. Signup form itself was not tested interactively (can't confirm email — transactional email broken per prior notes).

**Known blocker for real users:** Supabase confirmation email still uses `testoutlook`-style DNS, so a real signup email may bounce depending on provider. The Supabase dashboard URL config has been verified (per session memory), so the confirmation *link* lands correctly when the email arrives.

### 2. Post-signup → Dashboard

**Status: OK** — bootstrap user landed on `/dashboard` (not `/onboarding`). This means a user who already has a workspace (bootstrap seeds one) skips the workspace-creation step. A real new user would land on `/onboarding/workspace` first. That step was not exercised here; assume it works because earlier sessions verified it.

Dashboard shows:
- Workspace name as `<h1>` (not "Dashboard") — minor label issue, see friction inventory
- Activation card: "Connect your first channel" (correct for 0-channel state)
- KPI band: 0 posts shipped, 0 impressions
- Calendar: empty state with "Generate plan" CTA
- No console errors

### 3. Onboarding Wizard — Step 1: Brief (`/onboarding/wizard?step=1`)

**Status: FRICTION** — the step opens with only two interactive elements visible:
- A URL input ("Your website") + disabled "Read my site" button
- A small text link: "Or fill it in manually →"

**The 6 brief fields (Product, Voice, Audience, etc.) are hidden behind a toggle** — they only appear after either: (a) the AI URL-scraper runs, or (b) the user clicks "Or fill it in manually →".

A new user who doesn't have a website URL, or doesn't understand why they should paste one, faces a blank screen with a disabled primary action and a subtle secondary escape. There is no explicit "skip" on this step — the shell footer shows "Skip for now → step=2" but it's small, low-contrast text at the bottom.

**Time on this step:** Likely 5–15 minutes for a careful user, or complete abandonment for a hurried one.

### 4. Onboarding Wizard — Step 2: Channels (`/onboarding/wizard?step=2`)

**Status: HARD CLIFF — single biggest activation bottleneck**

A brand-new user (0 connected channels) lands on the **"Find me handles"** tab by default (line 100 of `step-2-channels.tsx`: `const [mode, setMode] = useState<Mode>(hasAny || justConnected ? "connect" : "find")`). The channel connect grid is not visible.

The user sees:
- A handle-discovery panel (AI username suggestions)
- A "I've got my accounts — connect them" outline button at the bottom

To connect a channel, a new user must:
1. Realise they need to switch tabs (toggle is not labelled prominently as "connect vs. discover")
2. Click "I have accounts" tab
3. See the channel grid
4. Click a channel card → OAuth redirect → return to this step
5. Click "Continue to plan"

**The segment toggle and the implied instruction ("you need an account to connect before you can continue") are not obvious to an ICP user (solo founder, build-in-public).** They came here to connect a channel; showing them handle discovery first creates confusion.

The "Continue to plan" button is disabled and shows "Connect at least one channel" until ≥1 channel is connected. There is no skip on this step by design (correct gate), but there is also no explicit "I already have accounts — start here" instruction for the user in the default "Find me handles" view.

For the dogfood session (LinkedIn seeded as `status: connected`), this step rendered correctly with the connect grid showing LinkedIn as "connected" — but only because the seeded account exists. A real user would arrive here on the "Find me handles" tab with an empty screen.

**This is the known "OAuth cliff"** — channel connect requires real OAuth. The dogfood harness cannot automate that. What was verified: the Connect grid renders correctly post-connect, the "Continue to plan" button correctly gates on ≥1 connected channel, and no "Skip for now" bypass exists.

### 5. Onboarding Wizard — Step 3: Plan generation (`/onboarding/wizard?step=3`)

**Status: BLOCKER (conditional)** — step 3 checks for both a brand brief AND a connected channel as prereqs.

If the brief is missing (common for users who skipped/rushed step 1), the page shows a non-functional state:
- Title: "Almost — we need a brief first"
- Only element: a "Write the brief →" link to step=1
- An "I'll do this later" link — **which also goes to step=1**, not forward or to the dashboard

**"I'll do this later" = a dead-end loop back to step 1.** A user who doesn't want to fill in the brief right now has no forward path. The intended behaviour (from the comment in `page.tsx`) is correct — the brief is necessary — but the "I'll do this later" label implies escape, not backtrack. This causes confusion and likely drop-off.

When the brief IS filled in, step 3 renders the plan generation form. This path was not fully tested due to the seeded LinkedIn account not having a real brief.

### 6. Onboarding Wizard — Step 4: Done (`/onboarding/wizard?step=4`)

**Status: OK** — verified by `run-activation-verify.mjs`:
- "Publish my first post now" button: present (1)
- Draft preview header: present (1)
- No console errors

This is the best-executed step. The "publish in one click" pattern is solid.

### 7. Approval Queue (`/queue`)

**Status: FUNCTIONAL — minor UX issue**

With seeded posts: 2 `pending_approval` drafts render, each with "Approve", "Publish now", "Edit", "Reject" action buttons. Tag chips visible. This works correctly.

**UX issue:** The queue shows `[role="alert"]` (empty, no visible text) in the DOM. One console 404 was recorded on a different page navigation. The queue page itself had no page errors.

**Missing "generate a plan" nudge from queue empty-state:** A user who arrives at `/queue` with 0 posts sees:
- "Inbox zero" with a "Generate plan" CTA
- The CTA links to `/plans/new` — this page was not tested

The `/queue/generate` route (tried during the walk) returned **404 — Page not found**. If any navigation in the app points to `/queue/generate`, those links are dead.

### 8. Settings → Channels (`/settings/channels`)

**Status: OK** — 5 "Connect X/Threads/Instagram/Facebook/Bluesky" tiles visible. LinkedIn and TikTok show "Coming soon". YouTube hidden (env unset).

**`FirstPlanCta` did not render** during the post-seed run (`channels 'fill your queue' CTA: 0`). This is because the dogfood user had a seeded LinkedIn account AND a seeded posting_plan (seeded in `run-activation-verify.mjs`). The CTA correctly requires `hasConnectedChannel && !hasPlan`. With a plan present, it hides — working as designed.

### 9. Dashboard (post-seed)

**Status: PARTIALLY CORRECT**

After seeding a channel + posting_plan: dashboard activation card correctly progressed to "Publish your first post" (confirmed by `run-activation-batch-verify` post-seed run). This is the correct state transition.

However: the `dashboard-full` screenshot produced an empty `main` text snippet — this may be a race condition in the custom walk script (main content loaded after the read). The activation card logic is confirmed correct via the batch-verify script.

**Dashboard H1 is the workspace name** ("Dogfood mqlw4uib"), not "Dashboard". This is intentional per the source, but may confuse a user who expects a page title.

---

## Friction Inventory

| # | Location | Severity | Issue |
|---|----------|----------|-------|
| 1 | Step 2 (wizard) | **HIGH** | New users (0 channels) land on "Find me handles" tab by default. The channel connect grid is hidden. Users wanting to connect an existing account must discover the tab toggle. |
| 2 | Step 1 (wizard) | **HIGH** | Brief fields are hidden behind the URL input; "Or fill it in manually →" is small and secondary. A user without a website URL faces a blank screen with a disabled CTA. |
| 3 | Step 3 (wizard) | **MEDIUM** | "I'll do this later" sends the user back to step 1, not forward. Label implies escape but behaviour is a backtrack loop. |
| 4 | Dashboard | **MEDIUM** | Dashboard `<h1>` is the workspace name (e.g. "Dogfood Corp"), not a page label. New users may be disoriented — "which screen am I on?". |
| 5 | `/queue/generate` | **MEDIUM** | Route returns 404. If any in-app link points to it, those are dead. |
| 6 | Step 1 (wizard) | **LOW** | The wizard's "Skip for now → step 2" footer link (small, muted text) effectively lets users bypass the brief. That's intentional, but the skip is visually de-prioritised to the point of being missed, so users may believe they're stuck. |
| 7 | Step 2 (wizard) | **LOW** | No "I already have all my channels — skip to planning" fast-path once you've connected 1+. The "Continue to plan" button is the fast-path but is below the toggle and below the channel grid. |
| 8 | Queue empty-state | **LOW** | `/queue` empty-state says "Generate a plan" and links to `/plans/new`, but the onboarding flow drives users through `/onboarding/wizard?step=3`. Two different entry points to the same underlying action — creates confusion about which one to use. |

---

## Estimated Time-to-First-Publish (TTFP)

### Frictionless path (user has website, all accounts exist, knows the product)

| Step | Time estimate |
|------|--------------|
| Signup + email confirm (if email delivers) | 3–5 min |
| Step 1 brief: paste URL → AI fills → review → save | 3–5 min |
| Step 2: connect channel (OAuth round-trip) | 2–4 min |
| Step 3: generate plan (AI generation) | 1–2 min |
| Step 4: review + click "Publish my first post now" | 1–2 min |
| **Total** | **10–18 min** |

### Realistic path for ICP (solo founder, no website, on X + maybe one other platform)

| Step | Notes | Time estimate |
|------|-------|--------------|
| Signup + email confirm | Email confirmation delivery unreliable | 5–15 min (blocker if email doesn't arrive) |
| Step 1 brief: no URL → clicks "manually" → fills 3 required fields | Hidden fields, manual fill | 8–15 min |
| Step 2: default "Find me handles" tab shown → discovers connect tab → OAuth | Tab discovery friction | 5–10 min |
| Step 3: generation | Works once prereqs are met | 1–2 min |
| Step 4: first publish | One click | 1 min |
| **Total (optimistic)** | | **20–43 min** |
| **Drop-off: step 2 tab confusion or email delivery fail** | Many users won't make it | — |

**North Star observation:** TTFP for a motivated user is ~20 minutes if everything works. The step-2 tab default and the hidden brief fields are the two biggest time killers. A frictionless user could hit 10 minutes, but that requires both a website to paste AND immediately understanding the toggle.

---

## Ranked Fixes

### Fix 1 — Step 2: default to "I have accounts" tab for all users (HIGHEST LEVERAGE)

**Problem:** `Step2Channels` defaults to `mode = "find"` for new users (0 channels). The channel connect grid is hidden. The value of step 2 is connecting a channel, but that's not what a new user sees first.

**Fix:** Flip the default. Show the connect grid first for all users. Move "Find me handles" to the secondary/right tab position. Users who genuinely don't have accounts yet will find the "Find me handles" button on the connect grid (it already exists as a dashed card at the bottom of `ConnectGrid`).

**File:** `src/app/onboarding/wizard/step-2-channels.tsx`, line 100

Change:
```typescript
const [mode, setMode] = useState<Mode>(hasAny || justConnected ? "connect" : "find");
```
To:
```typescript
const [mode, setMode] = useState<Mode>(justConnected ? "connect" : "connect");
// Or simply: const [mode, setMode] = useState<Mode>("connect");
```

**Impact:** Eliminates a full tab-discovery friction step for 100% of new users. The handle-finder remains available via the prominent dashed card on the connect grid.

---

### Fix 2 — Step 1: reveal the brief fields by default when no URL is pasted (HIGH LEVERAGE)

**Problem:** `Step1Brief` hides the 6 form fields behind a toggle (`revealed` state starts `false` for new users). A user who doesn't have a website or doesn't understand the URL input sees a blank step with one disabled button and a tiny "Or fill it in manually →" link.

**Fix:** Set `revealed = true` by default (or at minimum, render the fields collapsed but visible as a preview so the user knows they can type). Alternatively, show a prominent secondary CTA — "Start typing instead" — as a large button, not a small inline link.

**File:** `src/app/onboarding/wizard/step-1-brief.tsx`, line 82

Change:
```typescript
const [revealed, setRevealed] = useState<boolean>(initialBrief !== null);
```
To:
```typescript
const [revealed, setRevealed] = useState<boolean>(true);
```

This keeps the URL-paste hero at the top (AI fill is faster when it works) but makes the fields immediately visible and editable below it. The AI fill can still populate them when a URL is pasted.

**Impact:** Every user without a website URL can make progress immediately. Eliminates the "blank screen with disabled button" dead-end.

---

### Fix 3 — Step 3 "I'll do this later" loop: change target from step=1 to /dashboard

**Problem:** When a user arrives at step 3 without a brief, the "I'll do this later" link sends them to `step=1`, not out of the wizard. The label implies exit ("later") but the behaviour is a circular redirect (step 3 → step 1 → step 3 when the user returns). This is a trust break: users expect "later" to mean "I'll leave and come back", not "go backwards".

**Fix:** Change the `skipHref` for the "no brief" preflight block to `/dashboard` and update the label to "Return to dashboard".

**File:** `src/app/onboarding/wizard/page.tsx`, lines 103–119

Change the `skipHref` from `/onboarding/wizard?step=1` to `/dashboard` (or `/dashboard` with a toast nudge via query param), and change `skipLabel` from `"I'll do this later"` to `"Return to dashboard"`.

**Impact:** Stops the confusion loop. A user who genuinely wants to skip the brief can escape to the dashboard, where the activation card will point them back to the relevant step when they're ready.

---

### Bonus — Fix 4: `/queue/generate` 404

**Problem:** The route `/queue/generate` returns a 404. Any in-app link pointing there is a dead end.

**Fix:** Either (a) create the route, or (b) audit for any `href="/queue/generate"` links and redirect them to `/plans/new` (the equivalent existing route). Low effort, prevents user confusion if any surface links to it.

**Files:** `grep -r "/queue/generate" src/` to find all references.

---

## Cleanup Confirmation

`scripts/dogfood/cleanup.mjs` ran successfully. The throwaway user `e2e+dogfood-mqlw4uib@marketingmagic-tests.local` and its workspace `dogfood-mqlw4uib` were deleted from prod Supabase with no errors.
