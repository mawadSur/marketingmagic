export const meta = {
  name: 'mm-design-review',
  description: 'Whole-project UI/UX design + layout review for marketingmagic, producing a prioritized agent-ready task list',
  phases: [
    { title: 'Review' },
    { title: 'Verify' },
    { title: 'Synthesize' },
  ],
}

// Grounding facts established before this run (so reviewers don't re-derive and
// don't hallucinate a different stack). This is a Next.js App Router web app,
// NOT React Native. Tailwind + shadcn-style ui components + CSS-var tokens.
const CONTEXT = `
PROJECT: marketingmagic — a Next.js (App Router) web SaaS for AI social-media
planning/scheduling. NOT React Native. Repo root: /Users/mawad/Desktop/hunger/marketingmagic.

STACK: Next 16 App Router, React server components, Tailwind CSS, shadcn-style
primitives in src/components/ui/, lucide-react icons, Plus Jakarta Sans
(next/font). Pages live in src/app/(app)/ (authed product) and src/app/ (public
marketing/auth). Global styles + design tokens in src/app/globals.css.

OBSERVED (live, this session):
- Marketing landing (/) is LIGHT themed with a violet/indigo accent; clean,
  conventional SaaS hero + features + how-it-works + footer. Mobile (390px)
  reflows correctly.
- The APP manifest + viewport themeColor is DARK (#0a0a0a). The header brand is
  a CSS "mm" gradient badge (dark square). A real icon set (mm monogram on
  #0a0a0a) was just shipped to public/ (icon.png, apple-icon.png, favicon*).
- Login (/login) shows the dark "mm" badge on white; the subtitle "Log in to
  your marketingmagic workspace." renders as low-contrast gray-on-white.
- POTENTIAL BRAND SPLIT: light marketing site + violet accent vs dark app theme
  (#0a0a0a) vs dark logo. Worth assessing for coherence.

CONSTRAINTS: keep files <500 lines; tokens over raw hex; match existing
conventions; this review feeds a task list, not direct edits.
`

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['dimension', 'findings'],
  properties: {
    dimension: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'severity', 'location', 'problem', 'fix', 'effort'],
        properties: {
          title: { type: 'string', description: 'short imperative task title' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          location: { type: 'string', description: 'file:line or page/area; be specific, cite real paths you read' },
          problem: { type: 'string', description: 'what is wrong and the user impact' },
          fix: { type: 'string', description: 'concrete change to make' },
          effort: { type: 'string', enum: ['S', 'M', 'L'] },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['real', 'severityOk', 'reason'],
  properties: {
    real: { type: 'boolean', description: 'true if the finding is a genuine issue verifiable in the actual code/UI' },
    severityOk: { type: 'boolean', description: 'true if the stated severity is appropriate (not inflated)' },
    correctedSeverity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', ''], description: 'if severityOk is false, the right severity; else ""' },
    reason: { type: 'string' },
  },
}

const DIMENSIONS = [
  {
    key: 'brand-consistency',
    prompt: `Review BRAND + VISUAL CONSISTENCY across the whole project. Read the marketing landing page (find it under src/app/ — likely page.tsx), src/app/globals.css (tokens), tailwind config, src/components/app-header.tsx, the auth pages (src/app/(auth)/login, signup), and a sampling of src/app/(app)/ pages. Focus: the light-marketing-site vs dark-app-theme (#0a0a0a) vs dark-mm-logo split — is the brand coherent or fractured? Is the violet/indigo accent used consistently or arbitrarily? Is the "mm" CSS badge vs the new shipped icon.png logo used consistently? Spacing rhythm, card/border treatments, shadow scale consistency. Flag concrete inconsistencies with file:line.`,
  },
  {
    key: 'accessibility-contrast',
    prompt: `Review ACCESSIBILITY + CONTRAST. WCAG AA (4.5:1 body text, 3:1 large/UI). Specifically chase the gray-on-white low-contrast text seen on /login (the muted-foreground subtitle) and audit all uses of text-muted-foreground / text-gray-* on light backgrounds. Check focus-visible states on interactive elements, aria-labels on icon-only buttons (the Eye/EyeOff key toggles, the header logout, ExternalLink links), heading hierarchy, and color-only signaling (status badges). Read globals.css for the muted-foreground token value and judge its contrast. Cite file:line.`,
  },
  {
    key: 'responsive-layout',
    prompt: `Review RESPONSIVE + LAYOUT. Check container max-widths consistency across pages (max-w-* usage), the app-header nav (overflow-x-auto with 7 items — does it cramp/scroll badly on mobile?), the settings sub-nav, breakpoint consistency, min-h-screen vs dvh, and any fixed/sticky element offsets. The marketing landing reflows fine at 390px; focus on the AUTHED app pages (queue rows, channels list, dashboard widgets, video page) which are denser. Cite file:line.`,
  },
  {
    key: 'design-tokens',
    prompt: `Review DESIGN-TOKEN HYGIENE. Read src/app/globals.css and the Tailwind setup. Are colors driven by semantic CSS-var tokens (--primary, --muted, etc.) or are there raw hex / arbitrary Tailwind values (text-[#...], bg-[#...]) scattered in components? Grep src for hardcoded colors and arbitrary values. Is there a consistent spacing scale, radius scale, shadow scale? Is dark mode actually wired (a .dark class + tokens) given the app theme is dark but the marketing site renders light? Cite file:line and quote token definitions.`,
  },
  {
    key: 'typography',
    prompt: `Review TYPOGRAPHY. Plus Jakarta Sans is the only family (next/font). Check: consistent type scale (heading sizes, are they ad-hoc text-2xl/3xl per page or systematic?), line-height on body (1.5–1.75), line-length control on long-form (max-w on prose like /terms, /privacy), font-weight hierarchy, and tabular figures on numeric/data columns (dashboard metrics, queue counts, billing). Cite file:line.`,
  },
  {
    key: 'forms-feedback',
    prompt: `Review FORMS + FEEDBACK. This app is form-heavy: channel connect (x, bluesky), BYO key forms (video-keys, reference-video), brief, billing, team invites, queue actions. Check: visible labels (not placeholder-only), error placement near field, submit loading/disabled states, required indicators, success feedback, destructive-action confirmation (we just added disconnect — is it consistent?), empty states. Read a representative sample under src/app/(app)/settings/ and src/app/(app)/queue/. Cite file:line.`,
  },
  {
    key: 'navigation-ia',
    prompt: `Review NAVIGATION + INFORMATION ARCHITECTURE. Read src/components/app-header.tsx (7-item top nav, overflow-x-auto) and the settings layout/sub-nav. Check: active-state clarity, is the top nav scrollable-cramped on small screens, is there a logo-as-home link, breadcrumbs for deep settings pages (settings/channels/[id]), consistent back affordances, and whether primary vs secondary nav is clearly separated. Cite file:line.`,
  },
  {
    key: 'logo-icon',
    prompt: `Review the LOGO + ICON SYSTEM and recommend a concrete logo update. Current state: a CSS "mm" gradient badge in app-header.tsx + auth pages, plus a just-shipped raster mm monogram (public/icon.png etc., white mm on #0a0a0a). Issues to assess: (1) the brand mark is dark-only but the marketing site is light — does the logo work on light backgrounds? (2) raster PNG vs a crisp scalable SVG wordmark/mark; (3) the header uses a hand-rolled CSS badge instead of the real asset — inconsistent. Recommend a specific, actionable logo update direction (e.g. an SVG mm mark that adapts to light/dark via currentColor, used everywhere instead of the CSS badge). Return as findings with concrete fixes.`,
  },
]

phase('Review')
log(`Reviewing ${DIMENSIONS.length} design dimensions against the live app + code…`)

// Pipeline: each dimension is reviewed, then its findings are adversarially
// verified as soon as that review lands (no barrier between dimensions).
const reviewed = await pipeline(
  DIMENSIONS,
  (d) =>
    agent(
      `${CONTEXT}\n\nYou are a senior product designer + front-end engineer doing a rigorous design review. ${d.prompt}\n\nGround EVERY finding in code you actually read (cite real file:line). Do not invent issues. If a dimension is largely healthy, return few findings — quality over quantity. Severity: critical = broken/unusable or a11y failure; high = clearly hurts UX/polish; medium = inconsistency worth fixing; low = nice-to-have.`,
      { label: `review:${d.key}`, phase: 'Review', schema: FINDINGS_SCHEMA, agentType: 'Explore' }
    ),
  (review) => {
    if (!review || !review.findings?.length) return review
    // Verify each finding concurrently against the real code.
    return parallel(
      review.findings.map((f) => () =>
        agent(
          `${CONTEXT}\n\nAdversarially verify this design-review finding against the ACTUAL code. Open the cited location and surrounding files. Is it a REAL, accurate issue (not already handled, not a misread, correct stack)? Is the severity fair or inflated?\n\nFINDING:\ntitle: ${f.title}\nseverity: ${f.severity}\nlocation: ${f.location}\nproblem: ${f.problem}\nfix: ${f.fix}\n\nDefault to real=false if you cannot confirm it in the code.`,
          { label: `verify:${f.location}`.slice(0, 60), phase: 'Verify', schema: VERDICT_SCHEMA, agentType: 'Explore' }
        ).then((v) => ({ ...f, dimension: review.dimension, verdict: v }))
      )
    )
  }
)

// Flatten + keep only verified-real findings; apply corrected severities.
const confirmed = reviewed
  .flat()
  .filter(Boolean)
  .filter((f) => f.verdict?.real)
  .map((f) => ({
    ...f,
    severity: f.verdict.severityOk ? f.severity : (f.verdict.correctedSeverity || f.severity),
  }))

log(`${confirmed.length} findings survived verification.`)

phase('Synthesize')
const report = await agent(
  `${CONTEXT}\n\nHere are VERIFIED design-review findings (JSON). De-duplicate overlaps, group into a prioritized, AGENT-READY task list. For each task give: a clear title, severity, the files to touch, the concrete change, and effort (S/M/L). Order by severity then impact. Add a short "brand direction" preamble resolving the light-site/dark-app/logo tension into one recommendation. Also include a dedicated "Logo update" task with a specific direction. Output clean Markdown suitable for pasting into a tracker. Be concrete and honest; do not pad.\n\nFINDINGS JSON:\n${JSON.stringify(confirmed, null, 2)}`,
  { label: 'synthesize', phase: 'Synthesize' }
)

return { confirmedCount: confirmed.length, confirmed, report }
