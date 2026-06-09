# Design Review — TODO #2: Hormozi-style video marketing strategy

**Date:** 2026-06-08 · **Status:** Reviewed (CEO + Eng + Vision + Skeptic). **Verdict: build a thin slice, shelve the loop.**

This is the output of a 4-lens parallel design review (product, architecture, vision-provider,
adversarial). The four reviews converged hard, which makes the call confident.

---

## TL;DR

**Do NOT build the 7-phase Hormozi "AI feedback loop" now.** The premise — "learn which content
converts from real ROI/ROAS data" — is built on data we provably do not have:

- **No ad-platform integration** anywhere in `src/` (grep: zero ROAS/CPM/CPC). No Meta/TikTok Ads API.
- **`post_outcomes` is self-report only** (`outcome-schema.ts:9` — "no UTM / pixel"). A human types
  "$49.99" into a box. You can't run "separate outliers from flops" regression on that.
- **No paying customers yet** ([[no-real-customers-yet]]) — the loop has nothing to learn from.
  Building phases 4–6 now = "a hallucinated rubric with a feedback-loop UI" (CEO).

Five of the seven phases (1 partial, 2, 4, 5, 7) are load-bearing on ROAS/conversion data we can't get.

**Instead, build the wedge that delivers value on a SINGLE video with ZERO outcome data**, and
reframe the whole feature from paid-ads to organic.

---

## The reframe (the most important decision)

Hormozi's literal tactic — "run your best organic post as a paid AD, optimize on ROAS" — assumes the
user buys media and has a sales team. **Our users are organic-first solo creators / small biz.** If they
had ad budgets they'd be in Meta Ads Manager, not here.

**Reframe: "organic-as-ad / ROAS" → "double down on what your audience SAVES and BUYS."**
Keep Hormozi's actual *mechanic* (saves > views; organic-native format; hook-first; text-overlay CTA)
and drop the paid-ads dependency. The optimization signal becomes **saves + self-reported
`post_outcomes`** instead of ROAS. Paid-ad ROAS becomes a *later Agency-tier upgrade*, not the foundation.

---

## What to build NOW — the thin slice (organic-first, no loop)

A creator uploads/points at their best-performing clip → we tell them **why it worked** → we generate
**30 variations they can film**. Wows on day one, needs no ad spend, no attribution, no customers.

| # | Slice | Effort | Maps to | Hard deps |
|---|-------|--------|---------|-----------|
| 1 | **Persist `saves`** — add `post_metrics.saves`, wire `dispatchMetrics` (already fetches IG saves) into the cron insert | S (1 migration) | Phase 1 | none |
| 2 | **Video analysis** — transcribe + annotate first-5s hook / pattern interrupts / on-screen text. Standalone "here's what your hook actually shows." | L | Phase 3 | vision provider (below); byte-source scoping (below) |
| 3 | **Hook×body variation generator** — extend the atomizer to a 10 hooks × 3 bodies matrix | M | Phase 7 | none (rubric optional) |
| 4 | **Variation lineage** — `parent_post_id`/`variation_group_id` so variations trace to their source | S | enables future loop | none |

Positioned as a **Creator-tier ($97)** feature: *"Turn your best clip into 30 you can film."*

---

## Explicitly DEFER / KILL

- **KILL: automated ad-attribution / Hyros-style revenue tracking (Phase 2).** Huge integration surface,
  users mostly don't run ads, `post_outcomes` already covers the honest case. If ROAS is ever added,
  start with **manual entry** (`ad_outcomes` table sharing the recordOutcome pattern), not an ad-API build.
- **KILL: the "run as a paid ad" execution path.** We're a publishing tool, not an ad-buying platform.
- **DEFER: pattern-recognition + scoring rubric (Phases 4–5).** Worthless below ~30–50 outcome-tagged
  videos/workspace. **Phase 4 is NET-NEW, not `explain/` reuse** — `explain/outliers.ts` is per-post and
  *explicitly forbidden from cross-post generalization* (`extract.ts:118-125`); it only reuses the
  winner/loser *labeling*, not the analysis. It's the true critical-path chokepoint when we do build it.
- **DEFER/gate: synthetic-audience critique (Phase 6).** 10 LLM personas rating scripts = unfalsifiable
  theater with no demonstrated correlation to conversion. If built, ship as an *optional advisory button*,
  never a gate, under the same hedging discipline as `extract.ts`.
- **KILL: a multi-strategy abstraction layer.** Don't build a strategy framework for one strategy. YAGNI.

---

## The vision-provider decision (on the critical path for slice #2)

**Recommendation: add Gemini for the visual-annotation pass; keep Opus 4.8 as the downstream
copywriting brain.** This is the rare case where "Claude can't do it" is genuinely cleared:

- **Claude has NO video input type** — images/frames only (Messages API). The "first-5s motion /
  pattern interrupt" requirement is inherently *temporal*; a frames-only path structurally loses it.
- **Gemini 2.5 Flash ingests video natively** (audio + frames + temporal, tunable fps) — transcription +
  visual annotation + caption OCR in one pass.
- **Cost: ~50× cheaper.** Gemini Flash ≈ **$0.01/clip (~$10/mo for 1k clips)** vs Claude dense-keyframes
  ≈ **$0.50/clip (~$500/mo)** — per-frame image tokens are the killer.
- **Isolate behind one `analyzeVideo()` module** (new provider boundary; don't thread Gemini through the
  existing shared-Anthropic call sites). Feed its structured JSON to Opus 4.8 for the DR-copywriting analysis.
- **Fallback if Gemini is vetoed:** Whisper (ASR) + Claude high-res keyframes — accept the motion-fidelity hit.
- **DE-RISK FIRST with a ½–1 day spike:** run 8–10 real Reels (hard-cut-heavy + talking-head) through
  Gemini Flash vs Claude-keyframes; score hook/interrupt/caption-OCR recall. Confirm Gemini's OCR on
  stylized/animated captions (the riskiest part). **Do this spike before committing to slice #2.**

---

## Hard prerequisites / open questions before slice #2

1. **Byte-source scoping (hard prerequisite).** Our-rendered videos persist forever in the
   `post-media-video` bucket (no TTL) — addressable via `storage_path`. BUT the user's *best organic*
   videos were posted outside our pipeline → we may have only an `external_id`, not bytes. **Decide v1
   scope: analyze only-our-renders, or fetch the platform CDN URL.** Don't hand-wave this.
2. **Saves is IG-only today** (`dispatch.ts:91`); TikTok is a stub. The headline metric is missing on a
   headline short-form platform — capturing it broadly is real per-channel work, not just a column add.
3. **Higgsfield generation-style controls are unverified** (alpha, assumed REST contract). The "drop
   spoken CTA → text overlay" and "organic feel" changes need the provider to actually expose overlay/CTA
   control — `buildUgcRenderInput` only passes subject + copy today. Verify before promising those.
4. **AI-video "looks organic" ceiling (skeptic's strongest point).** Stock-footage-over-voiceover is the
   *most* algorithmically-flagged "this is an ad" format — the opposite of Hormozi's "looks organic" rule.
   The variation generator (slice #3) outputs *scripts to film*, sidestepping this; do NOT over-promise
   auto-generated video that passes as authentic organic.

---

## Recommended sequence

1. **Slice #1 (saves) + #4 (lineage)** — ship now, cheap, value compounds with time-in-market.
2. **Vision spike (½–1 day)** — resolve Gemini-vs-Claude with real clips.
3. **Slice #2 (video analysis)** — after the spike + byte-scoping decision.
4. **Slice #3 (hook×body variations)** — extend atomizer; can overlap #2.
5. **Revisit the loop (phases 4–6 + ROAS)** ONLY after real customers + outcome volume exist.

The "we already have the pieces" framing in the TODO is half-true: `post_outcomes` (Bet 1) and the
atomizer (Bet 2) genuinely transfer; phase 4 (corpus pattern engine), phase 3 (vision + non-Anthropic
provider), and the entire ROAS source are net-new.
