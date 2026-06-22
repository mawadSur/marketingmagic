# marketingmagic — Build-in-Public Self-Marketing Plan

**Date:** 2026-06-20 · **Owner:** Alex (operator) · **Channel:** X (lead) · **Wedge ICP:** solo founders / indie hackers / build-in-public.

> **The recursive bet.** marketingmagic is a tool that turns your build into build-in-public posts. The most credible proof we can offer is *to do exactly that with our own build.* This plan is the ongoing content engine that narrates marketingmagic building itself — grounded in real shipped commits, posted on X.

This is **not** the launch kit. The one-time launch playbook (X launch thread, Product Hunt, IndieHackers, Reddit) already lives at [`docs/launch/gtm-launch-kit.md`](../launch/gtm-launch-kit.md). **This doc is the sustainable, repeatable cadence** that runs *after* launch and keeps the account alive between milestones — the thing the GTM kit warns "falls off first."

---

## 0. Honesty guardrails (non-negotiable — same as the launch kit)

- **No real customers yet.** No fake user counts, no invented testimonials, no "X founders use this."
- Every post maps to a **real shipped commit or feature** (cited inline below). If it didn't ship, we don't claim it.
- Founder-honest voice: first person, dry, concrete, no hype, no emoji-spray. Being early *is* the story.
- "I/we built this and I'm using it to post this" is the strongest line we have — lean on it.

---

## 1. Voice

- **Person:** first person, founder-to-founder. Mohammed builds; "Alex" is the operator co-founder voice. Either works — keep it one consistent human voice per account.
- **Tone:** the way you'd tell another indie hacker what you shipped over coffee. Specific numbers over adjectives. Show the bug, then the fix. Admit what's early.
- **Anti-patterns to avoid:** "🚀 Excited to announce", "game-changer", thread-bait with no payoff, vague "we've been heads-down cooking" with nothing concrete, fake urgency.
- **Format discipline:** single tweets ≤280 chars. Threads marked `[THREAD]` with numbered tweets. Lead the *hook* with the concrete thing, not the meta ("I shipped X" not "big news coming").

---

## 2. Content pillars

Four pillars, each tied to a real surface of the work. Rough target mix per week: **40% Shipped, 25% Gotcha, 20% Behind the AI, 15% Journey.**

| # | Pillar | What it is | Why it works for this ICP | Source material |
|---|--------|-----------|---------------------------|-----------------|
| **P1** | **Shipped this week** | "Here's what went out + why it matters." A feature, a fix, a number. | Indie hackers reward visible momentum. This is the build-in-public staple. | Git log — every `feat`/`fix` commit. |
| **P2** | **Gotcha / this broke** | The candid "this almost shipped wrong, here's what I found and fixed." | Vulnerability + a real lesson = the most shared build-in-public format. Other builders learn from it. | Dedup bypass (`0f43ee9`), auth white-page (`570bb78`), `"use server"` Turbopack crash (`ea032e2`/`a4f70ff`), FAL 405 (`b4300ce`). |
| **P3** | **Behind the AI** | "Here's how the product actually decides X." Demystify the learning loop / plan-gen / dedup. | Differentiates from "yet another scheduler." Technical founders respect mechanism over magic. | Bayesian theme ranking, trigram-Jaccard dedup, recent-content context fed to the planner. |
| **P4** | **The journey / meta** | Pre-revenue honesty, the recursive "I used the tool to write this," metric instrumentation, the why. | Build-in-public *is* the journey. Authenticity is the moat when you have 0 customers. | North-Star `/admin/metrics` (`eb68ed6`), the build-in-public flow (`5d1b23b`), wedge decision. |

---

## 3. Cadence

Sustainable for a solo founder who is *also shipping the product* (the whole premise):

- **3–4 posts/week**, not daily. Daily is the trap that kills the account (see GTM kit). 3–4 is defensible forever.
- **1 thread/week max** (usually a P2 gotcha or P3 behind-the-AI — the formats that earn a thread). The rest are single tweets.
- **Reply > broadcast.** Budget more time replying to other build-in-public accounts than posting. Distribution on X is conversation, not megaphone.
- **Ship-day rule:** whenever a real `feat`/`fix` merges, that's a P1 post within 24h. The repo *is* the content calendar — this is the "prompt itself, see what's missing, execute" loop in practice.
- **Slot:** weekday early-afternoon, the product's own recommended X window. Confirm the exact slot with our own tool: `/tools/best-time-to-post/x`. Default used in the schedule below: **Tue–Thu ~1:30 PM ET**, with a Mon ~12:00 and a Fri ~11:00 as secondary slots.

---

## 4. The drafted posts (12–15, ready to publish)

> Each is grounded in a **real** shipped thing with the commit/feature cited. Single tweets are ≤280 chars (counts noted where tight). Threads are marked and numbered. Edit lightly for the live handle / a screen-recording where noted.

---

### Post 1 — P2 Gotcha · [THREAD] · **(strongest)**
*Grounds: dedup gate + the five-bypass audit — commits `691ae88`, `0f43ee9`.*

**1/**
My AI tool was about to start re-posting the same content.

I'm building a thing that auto-generates social posts. Turns out "generate a lot" + "auto-publish" = it can quietly repeat itself and spam your audience.

Here's the bug, and the fix that was bigger than I thought. 🧵

**2/**
The generator is stateless — it doesn't remember what's already in your queue. So two plans, a week apart, can produce near-identical "we shipped X" posts. On a trusted channel, the cron just… publishes both.

Nobody wants their feed to stutter.

**3/**
Fix v1: a dedup gate. SHA-256 for exact repeats, trigram-Jaccard similarity for near-dupes, checked against your recent + queued posts. A collision doesn't get auto-published — it's held for approval. Fail-open, so it never blocks generation.

**4/**
Then the part that humbled me. I'd gated the 2 paths I knew about.

An audit found **five** insert paths that auto-publish — the inbound webhook, the public API, the build-in-public flow, the sources flow, voice-memo. All five skipped the gate.

The bug is always bigger than the bug.

**5/**
So I routed every batch path through one shared choke-point and made the webhook + API run the gate inline. Now there's no door into "scheduled" that skips dedup, and every row stamps a content hash so the corpus stays whole.

974 tests green. Sleeping better.

**6/**
Lesson I keep relearning: when you find a bypass, assume it's not the only one. Grep for *every* path that reaches the dangerous state, not just the two you remember writing.

(Building marketingmagic in public — it turns your changelog into posts. Like this one.)

---

### Post 2 — P4 Journey / meta · single · **(strong)**
*Grounds: the build-in-public flow — commit `5d1b23b` (`/sources/build-in-public`).*

This post was drafted by the product it's about.

I shipped a flow where you paste your raw build updates and get a week of build-in-public posts back, led by X. So I pasted this week's commits into it.

Dogfooding all the way down.

*(~245 chars. Optional: attach a 20s screen-recording of `/sources/build-in-public`.)*

---

### Post 3 — P2 Gotcha · single · **(strong)**
*Grounds: auth confirm white-page fix — commit `570bb78`.*

A new user clicked "confirm your email" and landed on a blank white page.

Worst possible first impression, and I'd never have caught it from my logged-in account.

Hardened the callback, added a real confirm page + password reset, and a guard so the redirect can't be hijacked. Fixed.

*(~278 chars.)*

---

### Post 4 — P3 Behind the AI · single
*Grounds: the Bayesian learning loop (homepage "winning themes" board; learning-loop work).*

"AI for social" usually means "it writes posts." Mine does that, but the part I care about: it *measures*.

Every post is a signal. A Bayesian model ranks which of your themes — shipping updates, lessons, wins — actually move engagement, and quietly retires the duds.

The feed gets sharper weekly.

*(~280 chars — trim "shipping updates, lessons, wins" → "your themes" if X counts it long.)*

---

### Post 5 — P1 Shipped · single
*Grounds: PLG free tools — commits `8f9e568`, `d9e356f`, `9aff6e7`.*

Shipped two free tools, no signup needed:

→ Handle checker: is your username free across 8 platforms at once
→ Best time to post, per platform, from real engagement baselines

Built them because I wanted them. They're at /tools if they're useful to you too.

*(~250 chars. Add the live links once the handle is set.)*

---

### Post 6 — P2 Gotcha · single
*Grounds: the `"use server"` Turbopack runtime crash — commits `ea032e2`, `a4f70ff`.*

Today's footgun: a Next.js `"use server"` file that builds clean, passes type-check, and then crashes at runtime.

You can't export anything but async functions from it. Re-export a type and Turbopack lets the build pass — then throws a ReferenceError on the real request.

Caught it by dogfooding.

*(~280 chars — tighten if needed.)*

---

### Post 7 — P3 Behind the AI · single
*Grounds: recent-content context fed to planner — commit `691ae88` (`src/lib/plan/recent-content.ts`, prompt blocks).*

Stopping repeat posts isn't just a filter at the end.

Before the gate, I feed the model your recent + queued posts and your best/worst performers. So it steers *away* from angles you've already covered and *toward* what's landed — before it ever writes the dupe.

Prevention beats rejection.

*(~278 chars.)*

---

### Post 8 — P1 Shipped · single
*Grounds: 8th channel YouTube + 8-channel one-queue — commits `f8f5903`, registry work; homepage CHANNELS.*

One queue, eight channels: X, LinkedIn, Instagram, Threads, Facebook, Bluesky, TikTok, YouTube.

The point isn't the count — it's that you write the build-in-public update once and it gets reformatted per channel. I'm not rewriting the same "shipped X" five ways anymore.

*(~275 chars.)*

---

### Post 9 — P4 Journey · single
*Grounds: North-Star instrument + `/admin/metrics` — commits `eb68ed6`, `0bcbeae`, activation batch.*

You can't fix a funnel you can't see.

Built myself a North-Star dashboard before chasing growth: weekly active publishing workspaces, activation rate, time-to-first-post. It immediately showed the cliff is channel-connect, not signup.

Now I'm fixing the real bottleneck, not a guessed one.

*(~280 chars.)*

---

### Post 10 — P3 Behind the AI · single
*Grounds: AI short-form video, FAL FLUX → Kling i2v — commits `75c38cf`, `b4300ce`.*

The short-form video is generated end to end: a FLUX seed image → Kling image-to-video → captioned clip → out to every channel in the same approve-and-go flow as your posts.

No export dance, no second tool. Turn a feature you shipped into a clip without leaving the queue.

*(~280 chars.)*

---

### Post 11 — P2 Gotcha · single
*Grounds: FAL queue 405 bug — commit `b4300ce`.*

Spent too long on a 405 from the FAL video API.

The fix: don't poll the full model path for status — poll the status_url the queue *hands back to you*. The API tells you where to look; I just wasn't listening.

Most of my "API is broken" bugs are me not reading the response.

*(~272 chars.)*

---

### Post 12 — P1 Shipped · single
*Grounds: one-tap approve / auto-post on proven themes — homepage approval flow; dedup routes dupes to pending_approval.*

The whole product is one decision: approve, or trust it to post.

Default is approve-and-go — nothing publishes without you. Once a theme proves out, you can let it auto-post. Automatic when you're heads-down, never when you don't want it.

Shipped the gate that enforces that line today.

*(~280 chars.)*

---

### Post 13 — P4 Journey · single
*Grounds: pre-revenue honesty + wedge decision (memory: wedge-icp-decided).*

Honest status: marketingmagic has zero paying customers.

I'm not going to fake a wall of logos. I built it because I ship daily and post never, and I bet other solo founders have the same gap.

If that's you, I'd rather have your feedback than your money right now.

*(~272 chars.)*

---

### Post 14 — P3 Behind the AI · [THREAD]
*Grounds: dedup similarity internals — commit `691ae88` (`src/lib/dedup/similarity.ts`), `0f43ee9` (compiled equivalence).*

**1/**
How do you tell two AI-generated posts are "the same" without exact-matching?

Mine uses two layers, and the cheap one runs first. Quick thread on dupe detection. 🧵

**2/**
Layer 1 — exact: SHA-256 of the *normalized* text (lowercased, whitespace-collapsed, punctuation-stripped). Two posts that are character-identical after cleanup hash the same. O(1) lookup, catches verbatim repeats instantly. Including evergreen re-posts older than the recency window.

**3/**
Layer 2 — near-dup: trigram-Jaccard. Break each post into 3-char shingles, compare the overlap of the two sets. "We shipped dark mode" vs "Shipped dark mode today" score high → flagged. Different posts score low → pass.

**4/**
Perf trap: I was re-deriving every corpus post's trigrams for every new candidate. Now I compile each corpus entry's normalized text + trigrams *once* and reuse it. Behaviour-identical — locked by a 196-pair equivalence test so the optimization can't silently drift.

**5/**
The gate is fail-open: if the check errors, generation still works (it just doesn't dedupe that one). I'll take an occasional missed dupe over a blocked user. Reversible mistakes only.

(Building marketingmagic in public.)

---

### Post 15 — P1 Shipped · single
*Grounds: per-post performance verdict chip + exemplars — commit `691ae88` (`post-performance.ts`, queue-row chip).*

Small thing I love: every posted item in the queue now wears a verdict chip — did it beat your baseline or not.

And those winners/losers get fed back as examples into the next generation. The queue isn't just history anymore; it's the training signal.

*(~265 chars.)*

---

## 5. Two-week posting schedule

**Slots:** confirm exact times with `/tools/best-time-to-post/x`. Defaults below use weekday early-afternoon (the product's own recommended X window): primary **Tue/Wed/Thu ~1:30 PM ET**, secondary **Mon ~12:00**, **Fri ~11:00**. 3–4 posts/week, ≤1 thread/week. Mix is rotated so no two consecutive posts are the same pillar.

### Week 1

| Day | Slot (ET) | Post | Pillar | Format |
|-----|-----------|------|--------|--------|
| Mon | 12:00 | **Post 2** — "drafted by the product it's about" | P4 Journey | Single |
| Tue | 1:30 PM | **Post 1** — "my AI tool was about to re-post the same content" | P2 Gotcha | **Thread** |
| Thu | 1:30 PM | **Post 4** — "AI for social usually means it writes posts. Mine measures." | P3 Behind the AI | Single |
| Fri | 11:00 | **Post 5** — two free tools (handle checker + best time) | P1 Shipped | Single |

### Week 2

| Day | Slot (ET) | Post | Pillar | Format |
|-----|-----------|------|--------|--------|
| Mon | 12:00 | **Post 13** — "honest status: zero paying customers" | P4 Journey | Single |
| Tue | 1:30 PM | **Post 8** — one queue, eight channels | P1 Shipped | Single |
| Wed | 1:30 PM | **Post 14** — "how do you tell two AI posts are the same?" | P3 Behind the AI | **Thread** |
| Fri | 11:00 | **Post 3** — "a new user landed on a blank white page" | P2 Gotcha | Single |

**Bench (use as ship-day reactive posts or to backfill a slow week):** Posts 6, 7, 9, 10, 11, 12, 15. When a real `feat`/`fix` merges, post the matching P1 within 24h *instead of* the scheduled item and slide the schedule.

---

## 6. The self-driving loop (how this stays alive)

The intent is a workspace that "prompts itself, sees what's missing, and executes." Concretely, the repeatable loop:

1. **Watch the repo.** Every `feat`/`fix` merge to main is a candidate P1 post (the git log *is* the calendar).
2. **See what's missing.** If the week has no Gotcha, mine the last fix commit for the candid version. If no Behind-the-AI, pick the most interesting mechanism touched.
3. **Draft via the product.** Paste the week's real updates into `/sources/build-in-public` — the recursive proof, and it dedupes against what's already queued (the very feature we shipped).
4. **Human approves.** Mohammed/Alex review in the queue. Nothing posts unreviewed (honesty + the product's own promise).
5. **Measure.** Watch `/admin/metrics` + per-post verdict chips. Winners become exemplars; losing themes retire. Next week's plan leans into what landed.

> **Boundary reminder:** this doc produces *drafts only*. Publishing (or loading into the workspace queue) is a human action after review. Nothing here was posted.

---

*Drafted by Alex (operator). All copy honesty-gated: every post maps to a real shipped commit; no fabricated metrics or testimonials. Companion to [`docs/launch/gtm-launch-kit.md`](../launch/gtm-launch-kit.md) — that's the one-time launch; this is the ongoing engine.*
