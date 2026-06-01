# marketingmagic — value roadmap

Generated from a CEO-level product review (2026-06-01). Four prioritized bets,
sequenced by leverage, dependency, and effort. Effort shown human / with-CC.

## Market read
The 2026 social-tool market split: broad schedulers (Buffer/Hootsuite/Sprout)
are commodity infrastructure competing on price; the energy moved to specialized
AI growth tools (Taplio, video-clip generators) and short-form video. Teams run a
"growth stack." marketingmagic loses the scheduler fight on price — its wedge is
the growth layer the commodity players don't do: it **learns what works and
auto-iterates** (Bayesian theme-winners), ships **AI video in the same
approve-and-go flow**, and covers the hard channels. Position as a growth engine,
not a scheduler.

## 12-month dream-state delta
Today: solo/SMB autopilot, posts 7 channels, learns themes, makes video, read
near "scheduler", revenue = solo seats.
Ideal: the growth engine SMBs AND agencies run their social on — it learns each
brand's winners, proves ROI, and agencies resell it to 10–50 clients. Revenue =
agency ACV + expansion.
Biggest gap: the moat (learning loop) is invisible, and the highest-ACV customer
(agencies) isn't served yet.

## The bets

### ① Outcome repositioning + surface the learning loop — FIRST
Effort: S–M (~3 days / ~1–2 hr CC). Deps: none.
- Promote theme-winners onto the dashboard + analytics ("Your winning themes"),
  using existing `loadThemeWinners`/`computeThemeStats`.
- Weekly AI-review email → "what we learned and changed" digest.
- Shift product + landing copy from scheduling to outcomes.
Why first: cheapest, highest leverage, makes the moat visible, and produces the
outcome data the agency story (③) sells.

### ② PLG growth loop — PARALLEL
Effort: M (~4 days / ~2 hr CC). Deps: light (the `/start` preview funnel exists).
- Referral (invite → bonus quota), shareable preview link + OG card, free-tier
  "made with marketingmagic" attribution (off on paid).
Why: low-CAC acquisition that compounds while the big build runs.

### ③ Agency/org layer — THE REVENUE BUILD
Effort: L (~2–3 wks / ~1–2 days CC). Deps: ≥1 committed design partner + ①.
Already designed (`docs/agency-org-layer-design.md`); org checkout + migration
029 partly exist. Scope: org accounts, per-client workspaces, client report PDF
(consumes ①'s data), `/client/[token]` portal, white-label, full RLS audit.
Why: 5–20x ACV per account, stickier, expansion revenue. Gate on a real buyer.

### ④ AI-video wedge / reference-image — R&D TRACK
Effort: M–L, real unknowns. Deps: image-to-video model selection.
Base video pipeline ships today. The differentiator is the likeness feature
(upload your photo → video) — a NEW image-to-video model integration (BYO), not
the Pexels path. Prototype as exploration; lead marketing with video once proven.

## NOT in scope / deferred
- Two-way inbox community management (gated on Meta App Review).
- Apollo lead-gen (paused).
- P3 `preprocess_video` local-material edge (product path uses Pexels, unaffected).

## Sequencing
① first (dependency for ③, lifts every funnel) → ② in parallel (compounding
acquisition) → ③ gated on a design partner → ④ as R&D on the differentiator.
