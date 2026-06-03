export const meta = {
  name: 'mm-design-fix',
  description: 'Implement the design-review task list across disjoint file-clusters in parallel',
  phases: [{ title: 'Implement' }, { title: 'Verify' }],
}

const BASE = `/Users/mawad/Desktop/hunger/marketingmagic`

// Shared context every implementer gets. The brand foundation is ALREADY built
// (do not recreate it): the lead already added brand tokens + .brand-gradient
// + --positive to globals.css, created src/components/ui/logo.tsx (<Logo
// variant icon|full size sm|md|lg/>), and converted src/app/page.tsx +
// src/app/globals.css. Brand direction is LIGHT-FIRST + indigo/violet accent +
// the single <Logo> mm-monogram. Reuse, never re-hardcode.
const CONTEXT = `
PROJECT: marketingmagic — Next.js App Router web app at ${BASE}. Tailwind +
shadcn-style ui primitives in src/components/ui/, lucide-react icons, Plus
Jakarta Sans. NOT React Native.

ALREADY DONE by the lead (do NOT redo, just USE):
- src/components/ui/logo.tsx exists: <Logo variant="icon"|"full" size="sm"|"md"|"lg" className?/>.
  sm=24px tile, md=32px, lg=40px. The tile uses .brand-gradient with a white mm glyph.
- globals.css has tokens --brand-grad-start / --brand-grad-end (indigo→violet,
  light + dark), --positive (emerald success), and component classes
  .brand-gradient + .brand-gradient-text.
- src/app/page.tsx already converted (logo, gradient tokens, h-14, rounded-lg).

BRAND DIRECTION: light theme + indigo/violet accent via tokens + the single
<Logo> mark. Retire any "mm" CSS text badge or Sparkles-as-logo you encounter in
YOUR files; replace with <Logo>. Keep Sparkles as a generic feature icon only.

STANDARD focus-ring (codebase convention):
  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2

RULES: read each file before editing; match existing conventions; keep files
<500 lines; tokens over raw hex; do not touch files outside YOUR assigned list
(other agents own them — touching them causes conflicts). Run no build; the lead
verifies. Return a short summary of what you changed per file.
`

// Each cluster owns an EXCLUSIVE set of files — no overlap across clusters, so
// they run in parallel without clobbering each other. page.tsx + globals.css +
// logo.tsx are the lead's and excluded everywhere.
const CLUSTERS = [
  {
    key: 'auth-pages',
    files: 'src/app/(auth)/login/page.tsx, src/app/(auth)/signup/page.tsx, src/app/(auth)/invite/[token]/page.tsx',
    tasks: `Tasks 7(auth portion), 4, 24(login h1):
- Replace the "mm" CSS text badge / any logo markup on the login, signup, and invite pages with <Logo variant="full" size="lg" /> (import from "@/components/ui/logo"). Wrap any logo home-link with aria-label and the standard focus-ring.
- Darken the dim auth subtitle: replace text-muted-foreground on the "Log in to your…/Create your…" subtitles with text-foreground/80. (It passes AA at 4.76:1 but is dim on this high-friction page — polish only, scope to these subtitles, do NOT change the global token.)
- Bump the login/signup h1 from text-2xl to text-3xl font-semibold for heading-scale consistency.
- Add the standard focus-ring to the secondary links (Create an account / Log in).`,
  },
  {
    key: 'app-header',
    files: 'src/components/app-header.tsx, src/components/workspace-switcher.tsx',
    tasks: `Tasks 7(header), 2, 13, 31(active cue), 30:
- Replace the CSS "mm" gradient badge in app-header.tsx with <Logo variant="full" size="md" /> (the "marketingmagic" word stays hidden on mobile via the existing sm:inline pattern — pass variant that fits, or wrap so the wordmark hides on mobile; keep current behavior).
- Add aria-label="Go to dashboard" + the standard focus-ring to the logo home <Link>.
- Add the standard focus-ring to each nav <Link> and the Log out button.
- Nav compresses on ~358px (7 links): reduce horizontal padding under a small breakpoint (px-2.5 → px-1.5 on small) to reclaim space; move the active underline indicator INSIDE the scrollable row so it tracks (currently -bottom-[15px] sits outside the overflow strip and reads detached). Add font-semibold to the active link (color-only is weak).
- workspace-switcher.tsx: add aria-label="Select workspace" to the interactive <select>.`,
  },
  {
    key: 'settings-layout-nav',
    files: 'src/app/(app)/settings/layout.tsx, src/app/(app)/settings/organization/billing/page.tsx, src/app/(app)/settings/organization/branding/page.tsx',
    tasks: `Tasks 12, 31(back links):
- settings/layout.tsx sub-nav (9 tabs, overflow-x-auto): (a) add a fade/scroll affordance (a gradient mask or shadow on the right edge of the scroll strip) so hidden tabs are discoverable; (b) hide the redundant static "Settings" label on mobile (hidden sm:inline); (c) make the sub-nav visually subordinate to the top nav — use bg-background (not bg-muted/30 with a competing border) so hierarchy is clear. Add focus-rings to tab links.
- Add the existing inline back-link pattern (see src/app/(app)/settings/channels/[id]/page.tsx "← All channels") to the 3-levels-deep organization/billing and organization/branding pages, which currently have no parent path link.`,
  },
  {
    key: 'responsive-data',
    files: 'src/app/(app)/analytics/themes/page.tsx, src/app/(app)/dashboard/best-windows-widget.tsx',
    tasks: `Tasks 11, 14, 26:
- analytics/themes/page.tsx: a min-w-[680px] table forces horizontal scroll on 390px. Switch to a stacked card layout below md: (theme name + verdict + a small stat grid per row), full table at md: and up. Don't lose any columns; just reflow.
- best-windows-widget.tsx heatmap: min-w-[420px] truncates on 390px. Use min-w-[280px] sm:min-w-[420px] (or fewer columns below sm). Also replace the hardcoded #10b981 fill + outline-emerald-500 with the --positive token (hsl(var(--positive))), and add a brief comment that the 2px gap/radius is an intentional density outlier off the --radius scale.`,
  },
  {
    key: 'forms-connect',
    files: 'src/app/(app)/settings/channels/x/x-connect-form.tsx, src/app/(app)/settings/channels/bluesky/bluesky-connect-form.tsx, src/app/(app)/settings/team/invite-form.tsx',
    tasks: `Tasks 16, 17, 19, 23(invite):
- Add a visual required indicator (<span className="text-destructive">*</span>) to the labels of fields that use the HTML required attribute in all three forms.
- Make field-specific errors render directly under the offending field (text-xs text-destructive) for these multi-field forms; keep a form-level message only for non-field/network errors.
- Standardize success messages to text-sm text-emerald-600 dark:text-emerald-400.
- invite-form.tsx: the "Invitation sent…" success currently renders low-contrast and the form resets; make it a brief, more prominent inline banner (border-emerald-500/40 bg-emerald-500/5 rounded-md p-3).`,
  },
  {
    key: 'forms-keys-status',
    files: 'src/app/(app)/settings/video-keys/key-forms.tsx, src/app/(app)/settings/reference-video/key-form.tsx',
    tasks: `Tasks 5, 6, 16(keys), 19(keys):
- Add the standard focus-ring to the external "Get a key" <a> links and the Eye/EyeOff password-toggle <button>s. On the external links add title="Opens in new window" (the only new-window cue today is an aria-hidden icon).
- Status pills + success/error messages rely on color alone: prefix the "Configured ✓"/"Not configured" pill and success/error text with a lucide icon (CheckCircle2 for configured/success, AlertCircle for error, both aria-hidden), matching the pattern in src/app/onboarding/wizard/step-2-channels.tsx.
- Add a required * indicator to the key field labels. Standardize success text to text-sm text-emerald-600 dark:text-emerald-400.`,
  },
  {
    key: 'queue-forms',
    files: 'src/app/(app)/queue/queue-row.tsx, src/app/(app)/queue/new/compose-form.tsx, src/app/(app)/queue/page.tsx, src/app/(app)/settings/channels/[id]/disconnect-button.tsx',
    tasks: `Tasks 18, 20, 21, 22:
- queue-row.tsx: the "Confirm reject" button disables until a reason is chosen with no explanation. Add inline text-xs hints ("Select a reason to continue." / for the Other note "Required for 'Other'.").
- compose-form.tsx: when over the char limit, submit disables silently — add a text-xs text-destructive helper "Exceeds character limit by {n}".
- queue/page.tsx: link the "send a webhook event" text in the pending-approval empty state to /settings/events, and add an action to the "Nothing on the schedule" empty state (EmptyState supports an action prop).
- disconnect-button.tsx: add an AlertTriangle icon (aria-hidden) + the one-line "Stops all posting to this channel" lead-in before the buttons (the border-destructive/30 alone is faint).`,
  },
  {
    key: 'destructive-confirm',
    files: 'src/app/(app)/settings/events/event-rules-editor.tsx, src/app/(app)/settings/organization/branding/branding-forms.tsx',
    tasks: `Task 3:
- These have one-click destructive actions with no confirm. Add the existing two-step confirm pattern from src/app/(app)/settings/channels/[id]/disconnect-button.tsx (click → "Confirm"/"Cancel") to: the event-rule Delete button in event-rules-editor.tsx, and the Revoke button in branding-forms.tsx.
- For the branding Revoke, add inline copy noting it instantly disconnects live client-portal sessions. Use AlertTriangle (aria-hidden) where it fits. Keep it a client component pattern (useState confirming flag) like disconnect-button.tsx.`,
  },
  {
    key: 'typography-legal',
    files: 'src/app/privacy/page.tsx, src/app/terms/page.tsx, src/app/(app)/analytics/page.tsx, src/app/(app)/dashboard/page.tsx',
    tasks: `Tasks 27, 29, 24(dashboard h1):
- privacy/page.tsx + terms/page.tsx: remove the dead "prose prose-sm" classes (the @tailwindcss/typography plugin isn't installed, so they do nothing; styling already comes from text-sm leading-relaxed space-y-8). Just drop the two prose tokens.
- analytics/page.tsx + dashboard/page.tsx: add explicit tabular-nums to numeric metric value spans (KPI numbers) so refactors can't silently break column alignment (it currently relies on inheritance).
- dashboard/page.tsx: if the page h1 is text-3xl keep it; ensure it's font-semibold for the heading scale. Do not touch logic, only these className/typography tweaks.`,
  },
  {
    key: 'off-dom-tokens',
    files: 'src/lib/design-tokens.ts, src/lib/portal/branding.ts, src/app/p/[slug]/opengraph-image.tsx',
    tasks: `Task 25 (partial — only these files):
- Create src/lib/design-tokens.ts exporting named color constants used by server-side renderers that can't read CSS vars: ACCENT_INDIGO ("#4f46e5"), ACCENT_VIOLET ("#7c3aed"), NEUTRAL_DARK ("#0a0a0a"), TEXT_MUTED ("#64748b"), and any OG palette colors you find inline in opengraph-image.tsx. Add a comment on each linking it to its globals.css token (e.g. --brand-grad-start).
- Refactor src/lib/portal/branding.ts (its DEFAULT_ACCENT magic string) and src/app/p/[slug]/opengraph-image.tsx (inline hex palette) to import from design-tokens.ts. Do NOT change rendered colors — same values, just centralized. Read both files first to find the exact current hex values and reuse them.`,
  },
]

phase('Implement')
log(`Implementing ${CLUSTERS.length} disjoint file-clusters in parallel…`)

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['cluster', 'filesChanged', 'summary', 'notes'],
  properties: {
    cluster: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string', description: 'what changed, per file' },
    notes: { type: 'string', description: 'anything skipped, uncertain, or that needs lead attention' },
  },
}

const results = await pipeline(
  CLUSTERS,
  (c) =>
    agent(
      `${CONTEXT}\n\nYou OWN exactly these files (edit only these): ${c.files}\n\n${c.tasks}\n\nMake the edits now. Read each file first.`,
      { label: `impl:${c.key}`, phase: 'Implement', schema: RESULT_SCHEMA, agentType: 'coder' }
    ),
  // Verify the cluster's edits in isolation (typecheck-style read, not full build).
  (res, c) => {
    if (!res) return res
    return agent(
      `${CONTEXT}\n\nA coder just edited these files: ${c.files}\nThey reported: ${res.summary}\n\nReview ONLY these files. Check: (1) imports are correct (e.g. Logo imported from "@/components/ui/logo"), (2) no leftover references to removed symbols (e.g. Sparkles still imported but unused, or an old badge span left behind), (3) JSX is balanced and valid TSX, (4) the brand foundation was REUSED not re-hardcoded, (5) no obvious type errors. Report problems precisely with file:line, or confirm clean.`,
      { label: `verify:${c.key}`, phase: 'Verify', agentType: 'Explore' }
    ).then((review) => ({ ...res, review }))
  }
)

return { clusters: results.filter(Boolean) }
