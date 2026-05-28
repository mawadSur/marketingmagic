# OpenOutreach integration — compliance & risk memo

**Prepared:** 2026-05-24
**Subject:** Evaluating integration of `github.com/eracle/OpenOutreach` (LinkedIn lead-gen automation tool) into the marketingmagic SaaS product as a Pro/Agency/Founder feature.
**Repo metadata:** Python + Django + Playwright daemon, GPLv3, 1,910 stars, primary author: eracle. Author also operates a paid hosted version at `openoutreach.app`.

> **Not legal advice.** This memo is written by an engineering counterpart, not a lawyer. It exists to give a lawyer a fast, accurate read on the technical realities so their advice covers the right questions. Every legal conclusion below requires confirmation by counsel licensed in your operating jurisdiction.

---

## 1. Executive summary

Direct integration of OpenOutreach into marketingmagic, in any form where the two share an address space, package distribution, or installer, carries:

1. A **license-infection risk** (GPLv3 strong copyleft) that would require marketingmagic to also be GPLv3 — incompatible with running it as proprietary paid SaaS.
2. A **LinkedIn Terms of Service violation risk** that is high-severity: it can result in permanent LinkedIn account bans for our users, revocation of our official LinkedIn API approvals, and a cease & desist or lawsuit from LinkedIn directly. There is binding case law in this area (`hiQ Labs, Inc. v. LinkedIn`).
3. A **commercial conflict risk** with the OpenOutreach maintainer, who sells the same functionality as a managed service (`openoutreach.app`) and may treat a competing managed wrapper around their GPL code as bad-faith competition.
4. A **GDPR/CCPA risk** from automatically scraping and processing personal data of LinkedIn profiles, including profiles that have not consented to be processed by our system.
5. A **technical impedance mismatch** that makes any integration vastly more expensive than building equivalent functionality natively.

The lowest-risk path that delivers the same product outcome ("Pro/Agency/Founder users find leads") is to build the feature natively using LinkedIn's official OAuth API, a paid B2B data provider (Apollo, Clay, Crunchbase), or LLM-only suggestions. None of those approaches carries the risks above.

---

## 2. License analysis — GPL v3 strong copyleft

### Facts
- OpenOutreach `LICENSE` file declares **GNU General Public License v3** (`gh repo view` confirms; `licenseInfo.name = "Other"` in API response but README badge says GPLv3).
- The author **dual-licenses neither** — there is no commercial license offering visible in their README, only their own SaaS product running the same code.

### What GPLv3 requires
- Any work that "incorporates" or is "derived from" GPLv3 code, when distributed, must itself be released under GPLv3 with corresponding source code.
- The Free Software Foundation's interpretation: dynamic linking, static linking, importing as a library, and copying meaningful portions of code all create derivative works.
- The "SaaS loophole" (GPL has no network-use clause, unlike AGPL) means **running** GPL code as a backend service without distribution **may** sidestep the copyleft requirement — but courts have not definitively ruled on this for every architecture, and there is active legal debate.

### Practical implications for marketingmagic
- **Bundling OpenOutreach Python into the repo or Docker image** → marketingmagic must become GPLv3. Not compatible with proprietary paid SaaS.
- **Sidecar service in a separate container/process called by marketingmagic via HTTP** → the SaaS loophole *might* apply. Courts have not tested this exact pattern. Risk-tolerant companies do this with GPL'd backends; risk-averse companies do not. A lawyer should opine.
- **Modifying OpenOutreach and redistributing the modified version** → GPLv3 requires you to publish your modifications under GPLv3.

### Questions for counsel
1. Does the SaaS exception under GPLv3 §0 cover a sidecar container model where marketingmagic calls OpenOutreach over HTTP within our own infrastructure?
2. If we run an unmodified GPLv3 service on infrastructure we control, and only marketingmagic talks to it, is that "distribution" under GPLv3?
3. What is the precedent for offering a paid SaaS whose backend includes GPLv3 components running on our servers? (e.g. how do other SaaS companies handle GPL'd databases, scrapers, etc.?)

---

## 3. LinkedIn Terms of Service analysis

### Specific clauses violated by OpenOutreach's design

OpenOutreach's README explicitly describes:
- "Voyager API scraping" — Voyager is LinkedIn's *internal* API, not a public/published one. Use is for first-party LinkedIn clients only.
- "Playwright + stealth plugins mimic real user behavior" — designed specifically to evade LinkedIn's bot detection.
- Storing LinkedIn email + password to log in as the user.
- Automated sending of connection requests and follow-up DMs.

LinkedIn's User Agreement (governed by California law) prohibits, in §8.2:
> "Develop, support or use software, devices, scripts, robots or any other means or processes (including crawlers, browser plugins and add-ons, or any other technology) to scrape the Services or otherwise copy profiles and other data from the Services"
> "Use bots or other automated methods to access the Services, add or download contacts, send or redirect messages"
> "Bypass any access or use restrictions, such as rate limits"
> "Imply or state that you are affiliated with or endorsed by LinkedIn without our express consent"

All four are directly violated by OpenOutreach's architecture.

### Real-world enforcement precedent
- **hiQ Labs v. LinkedIn** (9th Circuit, 2022, remanded 2023) — LinkedIn won the right to enforce its ToS against scrapers under the CFAA. While public-data scraping itself isn't *criminal*, breach-of-contract claims under the User Agreement are enforceable, and LinkedIn has used them to obtain cease-and-desist and injunctive relief.
- LinkedIn maintains an active anti-bot enforcement team and regularly bans accounts that exhibit Voyager API patterns, stealth browser fingerprints, or automated connection request patterns.
- LinkedIn has revoked API access for developers found facilitating scraping, even when the scraping itself was done by their users.

### Risks if marketingmagic integrates OpenOutreach
1. **Our users get their LinkedIn accounts banned.** The reputational damage from "marketingmagic gets you LinkedIn-banned" would be severe.
2. **Our official LinkedIn OAuth client gets revoked.** We currently have a working Sign In with LinkedIn integration plus an in-flight Marketing Developer Platform application (submitted 2026-05-18 for `w_organization_social`). LinkedIn would almost certainly deny the MDP application and may revoke the existing OAuth client.
3. **LinkedIn cease & desist or lawsuit against marketingmagic.** Per `hiQ Labs`, LinkedIn actively pursues these.
4. **Personal liability exposure** — depending on jurisdiction, knowingly facilitating ToS violations may extend to officers/operators of the SaaS, not just the corporate entity.

### Questions for counsel
1. Is our exposure under LinkedIn's User Agreement different depending on whether (a) we host OpenOutreach in our infra and run it on behalf of users, or (b) we direct users to install and run it themselves?
2. Does providing "instructions plus a hosted UI" for users to deploy OpenOutreach themselves shield us, or does it count as inducing breach?
3. What is our exposure for an existing LinkedIn OAuth approval if we add this feature?
4. What is the precedent for SaaS products that have automated LinkedIn outreach features (e.g. Lemlist, Waalaxy) and how have they navigated ToS?

---

## 4. Data protection — GDPR / CCPA

OpenOutreach processes personal data of LinkedIn users *who have not consented to processing by our system*:
- Names, employment titles, employer names, profile photos, headlines.
- Inferred attributes (Bayesian classifier outputs: "ideal customer fit").
- Communication history (DMs sent and received).

Under GDPR:
- We would be a **data controller** for this processing (we decide purpose + means).
- The lawful basis would need to be either consent (impossible — we don't have it from the leads) or legitimate interest (high bar, requires a balancing test that may fail given LinkedIn's ToS prohibition).
- Affected individuals have GDPR rights (access, erasure, objection) that we would be obligated to honor. We would have no automated way to honor erasure requests against scraped LinkedIn data.

Under CCPA / CPRA: similar issues, plus mandatory disclosure of the data sources we collect from in our privacy notice.

Our current privacy policy (`/privacy`, shipped 2026-05-24) does not currently cover this kind of processing. Adding it would require disclosing that we scrape LinkedIn profiles on behalf of our users — which would also make our ToS violations more discoverable.

### Questions for counsel
1. Can we operate this feature under a "user is data controller, we are data processor" model where our users contractually take on the LinkedIn ToS and GDPR obligations? Does that hold up in EU jurisdictions?
2. What disclosures would our privacy policy need to add?
3. What contractual provisions in our customer ToS would protect us from end-user claims if their LinkedIn account is banned?

---

## 5. Commercial conflict with the OpenOutreach author

The README has a section titled "OpenOutreach Cloud — Zero Ops, Same AI" describing the maintainer's own paid hosted product. They sell the same functionality.

GPLv3 doesn't restrict competition, but if we build a managed wrapper around their GPL code:
- We are competing with them using their code.
- They may use *non-license* claims to push back (e.g. trademark on "OpenOutreach", advertising claims, etc.).
- Goodwill loss in the open-source community for "vampiring" a maintained project.

### Questions for counsel
- Trademark check on "OpenOutreach" if we ever use the name.
- Acceptable use of the name in marketing copy ("powered by OpenOutreach"?).

---

## 6. Technical impedance — why integration costs more than rebuilding

OpenOutreach is engineered as:
- Long-running Python daemon (Django + custom task queue).
- Persistent state in SQLite (DB lives on disk).
- Playwright browser session — long-lived, stateful, network-VPN-routed.
- VNC viewer for human-in-the-loop debugging.
- Cold start: 30-60 minutes per user, including LinkedIn account warming.

marketingmagic is:
- Stateless Next.js on Vercel serverless (10s function timeouts).
- Persistent state in Supabase Postgres.
- No browser execution layer at all.

To run OpenOutreach for end users, we would need:
- A per-user dedicated container running 24/7 (the maintainer's Cloud product confirms this is the operational shape).
- A per-user VPN endpoint (LinkedIn detects datacenter IPs and bans them).
- ~$15-30/month per active user in raw infrastructure, before our margin.
- An operations layer to provision, monitor, restart, and decommission containers.

Compared to building equivalent functionality natively in marketingmagic against the LinkedIn OAuth API, Apollo API, or LLM suggestions:
- Native build: 2-5 engineering days, $0 incremental infra per user, runs in our existing serverless model.
- OpenOutreach integration: 2-3 engineering weeks, $15-30/mo/user infra, dedicated devops, plus all the legal risks above.

---

## 7. Integration architecture options ranked by risk

If, after counsel review, we still want to proceed, here are the architectural options:

| Option | License risk | LinkedIn ToS risk | Infra cost | Notes |
|---|---|---|---|---|
| **A. Fork into marketingmagic repo** | **Extreme** (forces GPL on marketingmagic) | Extreme | Low | Don't do this. Effectively open-sources the company. |
| **B. Bundle as Docker sidecar in our infra** | High (untested at law) | Extreme | High ($15-30/mo/user) | Standard "GPL backend" pattern but no clear precedent for SaaS. |
| **C. Run OpenOutreach Cloud (their managed) on our users' behalf** | Low (we're a customer) | Still extreme (LinkedIn ToS isn't fixed by who hosts) | Medium (their pricing) | Trades license risk for vendor lock-in + still violates LinkedIn ToS. |
| **D. Direct users to self-install on their own machines, marketingmagic just generates campaigns and reads results** | Low (we don't distribute) | Medium (inducing breach claim possible) | None | Users still get banned, we get blamed. |
| **E. Don't integrate — build native lead-gen using legitimate APIs** | None | None | Per-user data-provider cost | Recommended. |

---

## 8. Recommended next steps

1. **Get counsel review.** Send this memo to a lawyer experienced in SaaS, IP, and Computer Fraud and Abuse Act / state computer-misuse statutes. Specifically ask the questions in §2.3, §3.3, §4.1.
2. **In parallel, prototype Path E natively.** Build a `/leads` page with LLM-only suggestions (2 days). This validates whether users actually want the feature before we commit to deeper investment.
3. **If users want richer data**, integrate Apollo or Clay API (5 days). Real leads, contractually clean, slots into the tier-limit model.
4. **Document the rejection of Option B in our architectural decision log** so the question doesn't quietly resurface.

If, after legal review, counsel is comfortable with Option B (sidecar), the implementation is significant and should be treated as a 3-week project including operations + onboarding, not a one-week integration.

---

## 9. Open questions for the founder before any work begins

1. Is the lead-gen feature an "any cost" priority, or is it one of several tier-differentiation features under consideration? (If the latter — Path E from §7 is dramatically cheaper.)
2. Do our paying customers expect *real names* of real people (Path B), or are *role+company suggestions* (Path E LLM) sufficient signal for them to find leads manually?
3. Is "Pro tier limited to N outputs" a hard requirement, or are we modeling it as a soft cap on a metered feature?
4. What is our risk tolerance for LinkedIn account bans of our users? (Even Path C/D carries this risk.)
5. Do we have legal counsel currently on retainer, or do we need to engage one before this question moves forward?

---

**End of memo.**
