# marketingmagic — TODO / backlog

Captured roadmap items not yet scheduled. Each is a future work item, not in flight.

---

## 1. Brand-consistent image + video generation

**What:** Image generation and video generation should match the workspace's brand styling
(colors, typography, visual tone, logo treatment) rather than producing generic output.

**Why:** Generated visuals currently don't inherit brand identity, so they look off-brand
next to the user's real content. On-brand visuals make the auto-generated content shippable
without manual restyling.

**Where to start:**
- Image gen: `src/lib/images/` (FAL integration) — thread brand style into the image prompt.
- Video gen: `src/lib/video/` (MPT render orchestration + provider adapters).
- Brand source: `brand_briefs` (voice/brand fields) + org branding bucket (migration 033,
  logo/colors) — a `BrandStyle` projection both generators consume.
- Likely a shared "brand style → prompt fragment" helper so image + video stay consistent.

**Effort:** M–L. **Priority:** P2.

---

## 2. Video marketing strategies — Hormozi-style organic-as-ad + AI feedback loop

**What:** Give video generation multiple marketing strategies (not one format). Headline
strategy to implement: Alex Hormozi's "organic content as paid ad" approach, plus an AI
feedback loop that learns which content converts and generates optimized variations.

**The strategy (Hormozi core):**
- Traditional rigid direct-response ads are ignored; the future merges organic + paid.
- Take your best-performing *organic* content and run it directly as an ad.
- For mid/bottom-funnel, optimize on **saves**, not views/follows.
- Drop the spoken CTA — use a simple text overlay/banner ("click to grab a thing").
- Ads that look exactly like organic content win (align with the platform's engagement goal).
- Real result cited: one ad hit 12.43x ROAS, cut cost-per-sale by ⅔ — but >half of organic
  videos flopped as ads, which is why the AI feedback loop matters.

**The AI feedback-loop workflow (maps cleanly onto our existing stack):**
1. **Data extraction** — pull organic metrics (saves, views, comments) + ad metrics
   (CPM, CPC). We already pull metrics via `cron/pull-metrics`; "saves" is a new metric to capture.
2. **Attribution** — connect sales to specific content. Note source used Hyros (native
   platform attribution is flawed). **Ties directly into our Bet 1 outcome loop** —
   `post_outcomes` is our self-reported attribution; this is the automated cousin.
3. **Visual + audio transcription (Gemini)** — transcribe spoken words AND annotate on-screen
   text, visual hooks, pattern interrupts (the first 5s visual often matters more than audio).
   NOTE: this is a non-Anthropic vision model (Gemini) — provider decision needed, or test
   whether Claude vision covers the annotation need.
4. **Pattern recognition (Claude)** — feed transcripts + visual data + sales data; Claude finds
   what separates winning outliers from losers. **Reuses our Bayesian theme-winner engine concept.**
5. **Scoring rubric** — Claude builds a skill scoring content on real ROI: hooks, social proof,
   script structure, conversion killers.
6. **Synthetic audiences** — Claude creates ~10 ICP-based customer avatars that critique new
   scripts against "deal breakers, buying triggers, scam detector."
7. **Content generation** — output ~30 variations from one concept (10 hooks × 3 bodies),
   film, run, feed results back to keep optimizing.

**Prompts the user provided to replicate manually (keep verbatim for when we automate):**
- *Visual/script analysis (vision model):* "...act as an expert direct-response copywriter.
  Transcribe the spoken audio, but more importantly, annotate all visual elements. Detail what
  happens on screen in the first 5 seconds, any pattern interrupts, and transcribe all on-screen
  text/captions. Complete breakdown of both visual and spoken hooks."
- *Pattern recognition & rubric (Claude):* "...transcripts, visual breakdowns, and actual ROAS
  data... create a 'Scoring Rubric'. Identify the exact patterns that separate the massive
  outliers from the flops. Which ad formats produce the highest return? How structure the body?
  How use social proof? What elements are killing conversions?"
- *Synthetic audience:* "...build a 'Synthetic Audience'. Create 10 customer avatars based on my
  ICP. Each evaluates this script on: buying triggers, deal breakers, scam detector. Ask 10
  additional critical questions and provide consensus on how to improve it."
- *Variations for filming:* "...Make me 30 more variations based on our winners. 10 completely
  different high-converting hooks (visual + spoken) paired with 3 different body script variations."

**Where this overlaps what we already built:**
- Bet 1 (outcome loop / `post_outcomes`) = the attribution + ROI signal this strategy needs.
- Bet 2 (atomization) = the variation-generation engine (extend to hook×body matrices).
- Theme-winner learning loop = the pattern-recognition core.
- Gap: capturing **saves** as a metric, video transcription/annotation (Gemini vs Claude
  vision decision), and the synthetic-audience critique step.

**Effort:** L–XL (multi-phase; depends on Bet 1 data + a video-vision provider). **Priority:** P2,
strategic. Likely its own CEO/eng review before building.

---

## 3. Pricing restructure — 4 products

Replace the current 4 tiers (Hobby $0 / Solo $29 / Agency $99 / Founder $149) with:

| # | Tier | Price | Scope |
|---|------|-------|-------|
| 1 | Free | $0 | **1 channel**, limited posting |
| 2 | (name TBD) | **$99/mo** | **One workspace**, all channels open, high limit |
| 3 | (name TBD) | **$199/mo** | **Multiple workspaces**, one product per workspace, all channels open |
| 4 | Commercial | **contact sales** | Multi-workspace, multi-product/service, all channels, **latest models**, enterprise |

**Implementation notes (`src/lib/billing/tiers.ts` + Stripe):**
- Current enum ids: `hobby`/`pro`/`agency`/`founder`. Changing ids touches the Stripe webhook,
  DB plan rows, and `STRIPE_PRICE_*` env vars — plan a migration/mapping, don't blind-rename.
- New axis: tiers 3 & 4 gate on **number of workspaces** and **products per workspace** — that's
  a new limit dimension (`workspaces`, `productsPerWorkspace`) not currently modeled.
- Tier 4 "latest models" implies a per-tier model-access gate (Opus for commercial vs cheaper
  models below) — new capability flag.
- Need new Stripe products/prices for $99 / $199; tier 4 is sales-led (no self-serve price).
- Existing customers on old tiers need a grandfathering/migration map.

**Effort:** M (billing changes are fiddly + revenue-sensitive). **Priority:** P1 (revenue),
but decide grandfathering before touching live Stripe.

---

## 4. B2B lead generation inside the workspace — evaluate OpenOutreach

**What:** Explore using https://github.com/eracle/OpenOutreach (LinkedIn lead-gen
automation) within a workspace to generate B2B leads as a product feature.

**⚠️ READ FIRST — `docs/openoutreach-integration-memo.md` (already in this repo).**
That memo evaluated exactly this and flagged severe risks. Summary of why this is NOT a
simple "add the library" task:
- **GPLv3 license infection** — OpenOutreach is strong-copyleft GPLv3 with no commercial
  dual-license. Bundling/linking it would force marketingmagic itself to GPLv3 (incompatible
  with proprietary paid SaaS). Only a separate-process sidecar *might* sidestep it (untested
  in court) — needs a lawyer.
- **LinkedIn ToS violation** — automated scraping/outreach can get our users permanently
  banned and revoke our official LinkedIn API approvals; binding case law exists (hiQ v. LinkedIn).
- **Commercial conflict** — the maintainer sells the same thing as a hosted service.
- **GDPR/CCPA** — auto-scraping LinkedIn profiles processes personal data without consent.

**Lowest-risk path to the SAME outcome ("workspace users find B2B leads")** per the memo:
build it natively on LinkedIn's *official* OAuth API, or a paid B2B data provider
(Apollo / Clay / Crunchbase), or LLM-only lead suggestions — none carry the above risks.

**Recommended next step:** treat this as a "lead-gen capability" product decision, not an
"integrate OpenOutreach" task. Scope the native/compliant approach; only revisit OpenOutreach
itself with legal sign-off. **Priority:** P2, needs legal + product review before any build.
Related: Apollo lead-gen was previously paused (see roadmap.md "NOT in scope").
