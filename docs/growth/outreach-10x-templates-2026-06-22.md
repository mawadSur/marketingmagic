# 10X Outreach — Templates & Content Engine (2026-06-22)

Companion to `outreach-10x-2026-06-22.md`. Reusable assets so the daily cadence runs fast without sounding mail-merged. Fill the `{{...}}` slots from the person's actual recent post (sourced live, §4 of the playbook).

**Voice:** peer founder, not a salesperson. Short. Specific. One ask. No buzzwords ("revolutionize," "10x your growth"). Never promise the coming-soon video feature.

---

## 1. X warm-DM templates (use AFTER engaging on their post)

**Structure that works:** (1) reference their *actual* post → (2) name the specific pain → (3) one-line what it does → (4) the free-Pro design-partner ask → (5) why *their* feedback specifically.

**Variant 1 — the solo shipper (default)**
> Hey {{name}} — saw your post about {{their_thing}}. The part that always bites after you ship is having to *also* keep {{product}} visible across X, LinkedIn, the rest, while you're heads-down building. That's exactly what I'm building marketingmagic to kill — it turns what you're shipping into a multi-channel content plan and posts it, you just approve. Free Pro if you'll run it a few weeks and tell me bluntly where it's wrong. A solo founder in the grind is the feedback I want most.

**Variant 2 — the volume/multi-product builder**
> Hey {{name}} — {{their_volume_signal, e.g. "shipping a product a month"}} is wild, and the one thing that obviously can't scale by hand is writing content for every launch across every channel. That's literally what marketingmagic is for: feed it what you're building, it plans + posts across X, LinkedIn, Bluesky and the rest. I'd love to give you free Pro and get your blunt take on whether it actually saves a maker time — if it doesn't, I want to hear that too.

**Variant 3 — the first-timer / small account**
> Hey {{name}} — been following your {{"day N of building" / first-SaaS}} posts, you're moving fast. Building's the easy part; staying visible while you build is the grind. marketingmagic turns your build-in-public updates into a multi-channel plan and posts them so the audience grows while you ship. Want free Pro to run it on your launch? You're exactly who I built it for, and your honest "this helped / this didn't" this early would be gold.

**Follow-up (Day 5, once, if no reply):**
> Hey {{name}} — no worries if it's not your thing. If you ever want a second pair of hands on distribution while you build, the free-Pro offer stands. Either way, rooting for {{product}}.

---

## 2. Engage-first reply playbook (Play A, Day 0)

The DM only works if you're not a stranger. One genuine reply on their latest post, 1–2 days before the DM. Rules:
- **Add value or curiosity, never pitch.** Ask a real question about their build, or share a specific take.
- **Be specific to *that* post** (proves you read it).
- Patterns that work:
  - *Genuine question:* "Are you weighting recent {{X}} heavier, or treating all history equally?"
  - *Specific empathy:* "The post-rejection ride is the most underrated debugging tool there is."
  - *Useful micro-tip:* "If you're testing names, {{tool}} checks handle availability across platforms in one go." ← natural place to drop our free `/tools/handle-checker` *as a helpful link, not a pitch*.
- **Never** drop the product link in the first reply. The link earns its place later.

---

## 3. Build-in-public content engine (Play B) — 10 ready posts

Post these from `@mawad1004` (or the brand account), 1/day, **scheduled through marketingmagic itself** (dogfooding = proof). Each is about building marketingmagic in public. End most with a soft, non-desperate hook. Swap in real numbers.

1. **The origin:** "I'm a solo founder who kept going quiet on X for weeks because I was heads-down shipping. So I built the thing that posts for me: AI turns what I ship into a content plan across 8 channels, I just approve. Building it in public. 👇"
2. **The hard problem (this dedup ship):** "Shipped a fix today: my tool was about to re-post near-identical content. Built a dedup gate (SHA-256 exact + trigram-Jaccard near-match) that routes any repeat to manual approval so it can never auto-post a dupe. The unglamorous stuff is the product."
3. **The learning loop (differentiator):** "Most schedulers post and forget. Mine measures every post and a Bayesian model finds which of *your* themes actually move engagement, then quietly retires the ones that don't. Your feed gets smarter weekly. Here's how it looks: {{screenshot}}."
4. **A real metric:** "Day {{N}}: {{signups}} signups, {{connected}} connected a channel, {{published}} published their first post. The drop-off from signup→connected is brutal and exactly where I'm focused this week. Building in public means showing the ugly funnel too."
5. **A teardown:** "Why I'm not chasing the channel-count war with the big schedulers. They have 30 integrations. I'm betting the moat is *intelligence* — better AI + outcomes — not more logos. Here's the bet."
6. **Coming-soon tease (honest):** "Next up: upload your own video, auto-transcribe it, cut it into clips, and market them across channels. It's in 'coming soon' in the app right now — DM me if you want early access when it flips on."
7. **A lesson/L:** "Spent a day on a feature nobody asked for. Classic. The thing people *actually* wanted was {{X}}. Reminder to self: talk to users before building. Who wants to be a design partner and keep me honest?"
8. **The free tool (lead magnet):** "Built a free thing: check if your handle is available across 8 platforms at once + see the best time to post on each. No signup. {{link to /tools}}. Built it because I needed it."
9. **Behind-the-scenes:** "The whole product runs on crons + a learning loop + a hybrid-approval queue. Here's the architecture {{diagram}}. Ask me anything about building a solo SaaS like this."
10. **The ask (weekly):** "Looking for {{N}} build-in-public founders to be design partners — free Pro, you use it weekly, you tell me bluntly what's broken. If you ship in public and hate the marketing tax, DM me."

**Engagement rule:** reply to every comment within an hour; the algorithm + the relationships are the point.

---

## 4. LinkedIn variant (Play B/A secondary)

Same content, longer-form, less hashtag. Lead with the lesson, end with the design-partner ask. Connect-request note:
> Hi {{name}} — fellow {{solo founder / indie builder}}. Building marketingmagic (AI that runs a founder's multi-channel content so they can keep building). Following your work on {{product}} — would love to connect and trade build-in-public notes.

---

## 5. Community value-posts (Play C)

**IndieHackers — milestone/story post (lead with value):**
> **Title:** I automated my own distribution so I could keep building — here's what I learned
> **Body:** I'm a solo founder. Every time I went heads-down to ship, my audience went cold, then I'd scramble to "do marketing" and lose a week. So I built a tool that turns shipping into a multi-channel content plan and posts it on approval. {{1–2 concrete lessons: the dedup problem, the learning loop, the signup→connect cliff}}. Happy to share how it's built. If you build in public and want to kick the tires, I'm taking a few design partners (free) — comment or DM.

**Reddit (r/SaaS, r/indiehackers, r/EntrepreneurRideAlong) — READ each sub's self-promo rules first:**
- Lead with a genuine lesson/teardown (the funnel drop-off, the dedup engineering, the "intelligence vs channel-count" bet).
- Mention the tool **once**, at the end, as context — not a CTA-heavy pitch. Reddit punishes salesiness hard.

**Build-in-public communities (WIP, X "Build in Public" community, Discords):**
- Post real daily/weekly progress (same as Play B). Be a member first, promote second. The relationships convert; the drive-by links don't.

---

## 6. Cold email (Play D) — 3-touch sequence

Only for founders whose email is public (site/GitHub). Send from a **separate warmed domain** (§7 of the playbook). Personalize line 1 from their product.

**Touch 1 (Day 0):**
> Subject: keeping {{product}} visible while you build
> Hi {{name}} — I came across {{product}} ({{specific detail}}). I'm building marketingmagic — it turns what a solo founder ships into a multi-channel content plan (X, LinkedIn, the rest) and posts it on approval, so the marketing runs while you build. I'm onboarding a few design partners with free Pro in exchange for weekly use + candid feedback. Worth a 10-minute look? — Mohammed

**Touch 2 (Day 3, reply to T1):**
> Quick follow-up — the reason I thought of you specifically: {{their build-in-public signal / multi-product / recent launch}}. The free-Pro design-partner spot is open if you want it.

**Touch 3 (Day 7, reply):**
> Last nudge, then I'll get out of your inbox — if distribution-while-building is ever a pain for {{product}}, the offer stands: {{link}}. Either way, rooting for you.

---

## 7. Quick rules (so none of this backfires)
- **Engage before you DM.** Always.
- **One ask per message.** The free-Pro design-partner spot. Nothing else.
- **Reference their real post.** If you can't, don't send — re-source.
- **Don't over-claim.** No video-upload promise (coming soon). No fake metrics.
- **Respect platform limits + ToS** (X DM warmup, Reddit self-promo rules, email warmup). Slow and warm beats fast and flagged.
- **Log every touch** in the tracker. The system is the 10X, not any single message.
