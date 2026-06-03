Key facts confirmed. Important corrections to fold into the task list:

1. **The marketing logo is a `Sparkles` icon, not "mm" text** — findings that say marketing uses an "mm" gradient badge are wrong; it's a Sparkles glyph in an indigo→violet gradient square. App/auth use the "mm" text badge. So the brand split is even sharper than one finding implies (different glyph AND different color system).
2. **`docs/brand/mm-mark.svg` already exists** — an adaptive `currentColor` mm-monogram SVG, but is unused. This makes the logo task far cheaper than "design from scratch."
3. **`--muted-foreground` light = `215.4 16.3% 46.9%`** → that's RGB ~(100,116,139) on white = **~4.76:1**, which *passes* WCAG AA. The "fails AA / 2:1 / critical" claims are wrong; the honest framing is "marginal AA, dim, worth darkening."

Below is the deliverable.

---

# marketingmagic — Design Review Task List

## Brand direction (read first)

There are three live, conflicting brand expressions:

- **Marketing site (`/`)** — light theme, a `Sparkles` icon inside an **indigo→violet** gradient square, plus indigo/violet gradient accents on the hero headline, "how it works", and footer. Hardcoded Tailwind colors, not tokens.
- **Auth + app** — a monochrome **"mm" text badge** (`from-foreground to-foreground/70`) that renders near-black on white, theme-aware.
- **Icon assets / manifest** — raster `mm` monogram on `#0a0a0a`, with the manifest declaring the canonical theme as **dark (`#0a0a0a`)**, even though no `.dark` class is ever applied at runtime (so the app currently renders light).

These are effectively three logos (Sparkles glyph, "mm" text, raster monogram) and two color systems (violet vs. neutral). A user going landing → login sees the glyph and color change *and* the gradient flatten to grayscale.

**Recommendation — one mark, one accent, light-first:**
1. **Adopt indigo→violet as the brand accent everywhere**, promoted to tokens (`--brand-grad-start` / `--brand-grad-end`). It is the most distinctive asset and already carries the marketing identity. The neutral app palette stays for surfaces/text; the brand gradient is reserved for the logo mark and a small number of accent moments.
2. **Adopt the existing `docs/brand/mm-mark.svg` monogram as the single logo mark** (it's already an adaptive `currentColor` SVG). Retire the `Sparkles`-as-logo and the "mm" text badge. `Sparkles` stays as a feature/UI icon, not as branding.
3. **Stay light-first.** The marketing site, auth, and app are all light today and read coherently as light. Change the manifest/`theme_color` from `#0a0a0a` to the light background and drop the implied "dark is canonical" stance, rather than forcing a dark theme nobody built. (Keep `.dark` tokens for a future opt-in toggle.) This resolves finding "dark mode wired but not enforced" without a risky theme flip.

Net: **light theme + indigo/violet accent + one mm-monogram SVG mark.** Most logo findings collapse into the single "Logo update" task below.

---

## P0 — Accessibility (ship first; small, high-trust wins)

### 1. Add focus-visible rings to all brand/logo and nav links
**Severity:** High · **Effort:** S
**Files:** `src/components/app-header.tsx` (logo link ~L50; nav links ~L70; "Log out" button ~L90), `src/app/(auth)/login/page.tsx` (logo ~L11; signup link ~L30), `src/app/(auth)/signup/page.tsx` (logo ~L11; login link ~L32), `src/app/(app)/settings/layout.tsx` (tab links ~L40)
**Change:** Add the codebase-standard `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2` to each interactive element above. For the Log-out button and inline text links use `ring-1` / `ring-offset-0` where a full offset ring would clip. Keep existing hover/active styles.
*(Consolidates the three separate focus-visible findings on brand links, auth secondary links, logout, and nav.)*

### 2. Add an accessible name to the logo home link
**Severity:** High · **Effort:** S
**Files:** `src/components/app-header.tsx` (~L50)
**Change:** Add `aria-label="Go to dashboard"` to the logo `<Link>`. Its only inner text (`mm` is `aria-hidden`, "marketingmagic" is CSS-hidden on mobile) leaves screen-reader users with no name. WCAG 4.1.2. Apply the same to auth-page logo links if they remain links.

### 3. Add confirmation to one-click destructive actions
**Severity:** High · **Effort:** M
**Files:** `src/app/(app)/settings/events/event-rules-editor.tsx` (Delete ~L66-72), `src/app/(app)/settings/organization/branding/branding-forms.tsx` (Revoke ~L361-367)
**Change:** Reuse the existing two-step confirm pattern from `src/app/(app)/settings/channels/[id]/disconnect-button.tsx` (click → "Confirm"). Both currently delete/revoke on a single click with no undo. Revoke also instantly disconnects live client portal sessions — add inline copy stating that.

### 4. Darken auth-page subtitle / muted text
**Severity:** High · **Effort:** S
**Files:** `src/app/(auth)/login/page.tsx` (~L20), `src/app/(auth)/signup/page.tsx` (~L20)
**Change:** Replace `text-muted-foreground` on the auth subtitles with `text-foreground/80`. Honest note: `--muted-foreground` light is `215.4 16.3% 46.9%` ≈ **4.76:1 on white — it passes WCAG AA**; the finding's "fails AA / critical" framing is wrong. This is a polish/readability fix on a high-friction page (dim thin gray on Plus Jakarta), not a violation. Do **not** globally change `--muted-foreground` (used everywhere); scope to the auth subtitles. The app-header Log-out contrast improves once it's not muted-only if you also bump it, but that's optional.

### 5. Add focus-visible + new-window indication to external links and password toggles
**Severity:** Medium · **Effort:** M
**Files:** `src/app/(app)/settings/reference-video/key-form.tsx` (external `<a>` ~L100-107; Eye/EyeOff toggle ~L90-97), `src/app/(app)/settings/video-keys/key-forms.tsx` (external links ~L99-107, ~L193-201; toggle ~L127-134)
**Change:** Add `focus-visible:ring-*` to the anchors and the password-toggle buttons. On external links add `title="Opens in new window"` (or visible SR text) since the only new-window cue today is an `aria-hidden` icon. Ignore the finding's `settings/key-forms.tsx` path — it doesn't exist; only the two files above.

### 6. Status pills and success/error messages rely on color alone
**Severity:** Medium · **Effort:** M
**Files:** `src/app/(app)/settings/reference-video/key-form.tsx` (pill ~L42-48; messages ~L135), `src/app/(app)/settings/video-keys/key-forms.tsx` (pills ~L226-234; messages ~L167-168, ~L206-207)
**Change:** Prefix status/feedback with a lucide icon (`CheckCircle2` for configured/success, `AlertCircle` for error), `aria-hidden`, matching the pattern already in `onboarding/step-2-channels.tsx`. WCAG 1.4.1.

---

## P1 — Brand & visual coherence

### 7. Logo update — unify on one adaptive mm-monogram SVG
**Severity:** High · **Effort:** M
**Files (create):** `src/components/ui/logo.tsx` (and optionally `src/lib/brand.ts`)
**Files (edit):** `src/app/page.tsx` (~L50 nav, ~L229 footer), `src/components/app-header.tsx` (~L54-59), `src/app/(auth)/login/page.tsx` (~L12-17), `src/app/(auth)/signup/page.tsx` (~L12-17), `src/app/(auth)/invite/[token]/page.tsx` (~L198-204)
**Direction (concrete):**
- Wrap the **already-existing** `docs/brand/mm-mark.svg` (an adaptive `currentColor` mm-monogram — the four-arch wordmark) as an inline React component `<Logo />`. Do not design a new mark; this one exists and is unused.
- `<Logo variant="icon" | "full" size="sm|md|lg" />`. Define size scale once: `sm=24px (nav/footer)`, `md=32px (app header)`, `lg=40px (auth center)` — this also closes the "badge size inconsistency" finding.
- **Color:** the icon square uses the brand gradient (token from Task 8) on a rounded-lg tile; the glyph is white via the SVG `currentColor`. This kills the three-way split: same mark, same gradient, in marketing nav, app header, auth, and footer.
- **Retire** the `Sparkles`-as-logo on marketing and the literal "mm" text badges. Keep `Sparkles` available as a generic feature icon.
- Optional `src/lib/brand.ts` exporting `LOGO_SIZES` + a one-line usage note, referenced from a comment in `logo.tsx`, to satisfy the "document logo usage" finding cheaply.
*(Consolidates: "replace CSS mm badge with SVG", "create adaptive SVG mark", "unify logo across sections", "logo badge size inconsistency", "document logo usage", and the logo half of "gradient splits".)*

### 8. Promote the indigo/violet brand accent into design tokens
**Severity:** High · **Effort:** M
**Files:** `src/app/globals.css` (`:root` and `.dark`), `src/app/page.tsx` (~L50, L76, L86, L149, L163, L229)
**Change:** Add `--brand-grad-start` (indigo-600) and `--brand-grad-end` (violet-600) to `:root` (and dark equivalents). Add a `.brand-gradient` component class (or use `bg-[linear-gradient(...)]` with the vars) and replace the hardcoded `from-indigo-600 to-violet-600` / `from-indigo-50/60` / `dark:from-indigo-950/20` / `dark:text-indigo-400` strings. The `<Logo>` tile (Task 7) consumes these same tokens. Do **not** repurpose the existing `--accent` token (it's the neutral surface token used by buttons/hover all over the app — overwriting it would recolor the whole UI). Use a new dedicated brand token instead.
*(Consolidates: "accent not tied to tokens", "hardcoded gradient colors", "accent mismatch between tokens and marketing", and the color half of "gradient splits". The finding's HSL conversions are approximate — pull exact HSL from Tailwind's indigo-600/violet-600.)*

### 9. Decide and apply the runtime theme (resolve dark-wired-but-light-rendered)
**Severity:** High · **Effort:** M
**Files:** `src/app/layout.tsx` (`<html>` ~L40, metadata ~L24-31), manifest, `src/app/page.tsx` (~L76, L149 dark: modifiers)
**Change:** Per the brand direction, commit to **light-first**: update the manifest `theme_color`/`background_color` from `#0a0a0a` to the light background so the declared theme matches what renders; there is no light↔dark flash because nothing flips. Leave `.dark` tokens in place for a future toggle, and either keep or remove the dead `dark:` modifiers on `page.tsx` (document them as reserved). If instead the team wants dark-canonical, add an inline pre-hydration script setting `.dark` on `<html>` — but that's a larger visual change and not recommended now.
*(Consolidates "dark mode not enforced at runtime" + "landing dark: modifiers are dead code." Pick one path; light-first is the low-risk one.)*

### 10. Standardize header height and card radius
**Severity:** Medium · **Effort:** S
**Files:** `src/app/page.tsx` (header ~L48 `h-16`; cards ~L147, L189 `rounded-xl`), `src/components/app-header.tsx` (~L49 `h-14`)
**Change:** Set the marketing header to `h-14` to match the app. For radius, standardize on `rounded-lg` (the `--radius`/`ui/card.tsx` standard, 8px) across marketing feature/step cards and the in-app `winning-themes-widget`; or, if a softer feel is wanted, bump `--radius` to 0.75rem once and let cards inherit. Don't leave marketing at `rounded-xl` while the app is `rounded-lg`.

---

## P1 — Responsive / layout

### 11. Analytics themes table overflows on mobile
**Severity:** High · **Effort:** M
**Files:** `src/app/(app)/analytics/themes/page.tsx` (~L67)
**Change:** `min-w-[680px]` forces horizontal scroll on a 390px viewport (~358px usable), fragmenting a 6-column comparison (Posts/Posterior/CI/Lift/Verdict). Either switch to a stacked card layout under `md:` (theme name + verdict + mini stat grid per row) or hide secondary columns below `md:` and reveal at the breakpoint.

### 12. Settings sub-nav: 9 tabs cramped + no scroll affordance + redundant label
**Severity:** Medium · **Effort:** M
**Files:** `src/app/(app)/settings/layout.tsx` (~L14-24 tab list, ~L30-32 label/container)
**Change:** Three related fixes in one pass: (a) add a fade/shadow scroll affordance (gradient mask on the `overflow-x-auto` strip) so hidden tabs are discoverable; (b) hide the redundant static "Settings" label on mobile (`hidden sm:inline`) to reclaim ~60px; (c) optionally group account-y tabs (Billing/Team/Organization) into a dropdown or a second row under `sm:`. Also clarify primary-vs-secondary nav hierarchy: the sub-nav's `bg-muted/30` + `border-b` reads equal to the top nav — make the sub-nav `bg-background` or drop one border.
*(Consolidates the three settings-sub-nav findings.)*

### 13. App-header nav compresses on narrow phones; active indicator detached
**Severity:** Medium · **Effort:** M
**Files:** `src/components/app-header.tsx` (~L49, L63 nav; ~L82 active indicator)
**Change:** 7 nav links (~490px) overflow the ~358px container; the active underline at `-bottom-[15px]` sits below the scroll area and reads disconnected. Reclaim space (reduce `px-2.5`→`px-1.5` under `sm:`, and/or collapse low-priority tabs into a menu on mobile) and move the active indicator inside the scrollable row so it tracks correctly.

### 14. Heatmap grid forces horizontal scroll on mobile
**Severity:** Medium · **Effort:** M
**Files:** `src/app/(app)/dashboard/best-windows-widget.tsx` (~L103)
**Change:** `min-w-[420px]` truncates the heatmap on a 390px phone. Use a responsive intrinsic width (`min-w-[280px] sm:min-w-[420px]`) or fewer columns below `sm:`.

### 15. Standardize page content max-width
**Severity:** Low · **Effort:** S
**Files:** `src/app/(app)/settings/channels/page.tsx` (~L99 `max-w-3xl`), `.../settings/video/page.tsx` (~L116), `.../settings/brief/page.tsx` (`max-w-2xl`), `.../queue/page.tsx`, `.../dashboard/page.tsx`
**Change:** Form-style settings pages use `max-w-2xl/3xl`; dense pages (queue, dashboard) fill the full container. Pick one rule — e.g., reading-column pages get `mx-auto max-w-3xl`, dense data pages stay full-width — and apply consistently. (The finding's "doesn't inherit py-8" claim is inaccurate; ignore it.)

---

## P2 — Forms & feedback

### 16. Add visual required-field indicators
**Severity:** Medium · **Effort:** S
**Files:** `src/app/(app)/settings/channels/x/x-connect-form.tsx` (~L16-35), `.../channels/bluesky/bluesky-connect-form.tsx` (~L17-35), `.../team/invite-form.tsx` (~L39-47), `.../video-keys/key-forms.tsx` (~L82-175)
**Change:** Fields use the HTML `required` attribute with no visual cue. Add `<span className="text-destructive">*</span>` (or equivalent) to required labels, consistently.

### 17. Make multi-field form errors field-adjacent
**Severity:** Medium · **Effort:** M
**Files:** `src/app/(app)/settings/channels/x/x-connect-form.tsx` (~L37-39), `.../channels/bluesky/bluesky-connect-form.tsx` (~L50-51), `.../settings/brief/brief-form.tsx` (~L104, ~L218)
**Change:** For field-specific errors in 4–6 field forms, render `text-xs text-destructive` directly under the offending field; reserve the bottom form-level message for non-field errors (network, etc.).

### 18. Queue rejection-reason: add required-field hints
**Severity:** Medium · **Effort:** S
**Files:** `src/app/(app)/queue/queue-row.tsx` (~L399-479)
**Change:** "Confirm reject" disables until a reason is picked (and a note for "Other") with no explanation. Add inline `text-xs` hints ("Select a reason to continue." / "Required for 'Other'.") so the disabled state is self-explanatory.

### 19. Standardize success-message color across forms
**Severity:** Medium · **Effort:** S
**Files:** `src/app/(app)/settings/channels/x/x-connect-form.tsx` (~L40-41), `.../channels/bluesky/bluesky-connect-form.tsx` (~L51), `.../video-keys/key-forms.tsx` (~L168), `.../reference-video/key-form.tsx` (~L135)
**Change:** Some success messages include a dark variant, others don't. Standardize all to `text-sm text-emerald-600 dark:text-emerald-400`.

### 20. Queue compose: explain why submit is disabled over the char limit
**Severity:** Low · **Effort:** S
**Files:** `src/app/(app)/queue/new/compose-form.tsx` (~L89-108)
**Change:** When over the limit the counter turns red and submit disables silently. Add `text-xs text-destructive` helper: `Exceeds character limit by {n}`.

### 21. Empty-state CTAs in the queue
**Severity:** Low · **Effort:** S
**Files:** `src/app/(app)/queue/page.tsx` (~L237-268)
**Change:** Link the "send a webhook event" text in the pending-approval empty state to `/settings/events`, and add an `action` to the "Nothing on the schedule" empty state (it currently has none, though `EmptyState` supports one).

### 22. Add a warning cue to the disconnect-channel block
**Severity:** Low · **Effort:** S
**Files:** `src/app/(app)/settings/channels/[id]/disconnect-button.tsx` (~L37-62)
**Change:** Two-step confirm is good. Add an `AlertTriangle` icon / one-line "Stops all posting to this channel" before the buttons (`border-destructive/30` at 30% is faint). Matches `no-channels-banner.tsx`.

### 23. Team-invite + billing feedback prominence
**Severity:** Low · **Effort:** M
**Files:** `src/app/(app)/settings/team/invite-form.tsx` (~L16-21, L63), `src/app/(app)/settings/billing/page.tsx` (~L63-92)
**Change:** Invite success ("Invitation sent…") renders in low-contrast `text-muted-foreground` and the form resets — make it a brief, more prominent inline banner. For billing, render a friendly banner when `subscription_status` is a non-paying state (incomplete/unpaid) prompting "Manage subscription," instead of showing raw status as monospace. Note: Stripe only redirects to success/cancel URLs, so the finding's `status=error` param is not the right mechanism — drive off the stored status.

---

## P2 — Typography & token hygiene (low-risk cleanup)

### 24. Establish a heading scale and default body line-height
**Severity:** Medium · **Effort:** M
**Files:** `src/app/globals.css` (`body` ~L52-55; add `@layer components`), `src/app/(auth)/login/page.tsx` (~L19), `src/app/(app)/dashboard/page.tsx` (~L40)
**Change:** h1 sizes are ad-hoc (login `text-2xl`, dashboard `text-3xl`, marketing `text-4xl sm:text-6xl`). Define h1–h4 conventions (e.g., h1 `text-3xl font-semibold`, h2 `text-lg font-semibold`, h3 `text-base font-medium`); bump login h1 to `text-3xl`; keep the marketing hero as a documented exception. Separately, set a default `leading-relaxed` on `body` so legal/long-form and UI pages stop diverging (`CardTitle`'s `leading-none` is intentional — add a clarifying comment there per the finding).
*(Consolidates "heading hierarchy", "default line-height", and the `CardTitle` doc finding.)*

### 25. Centralize hardcoded colors used outside CSS (email/portal/OG)
**Severity:** Medium · **Effort:** M
**Files (create):** `src/lib/design-tokens.ts`
**Files (edit):** `src/lib/portal/branding.ts` (~L13-14), `src/lib/portal/invite-email.ts`, `src/lib/dashboard/learning-digest.ts`, `src/app/p/[slug]/opengraph-image.tsx` (~L33-72)
**Change:** Email/portal/OG render server-side and can't read CSS vars, so they legitimately need hex — but those hex values are scattered magic strings (`DEFAULT_ACCENT` duplicated, OG palette inline). Export named constants (`ACCENT_BLUE`, `NEUTRAL_DARK`, `TEXT_MUTED`, `OG_BG_DARK`, …) with comments linking each to its `globals.css` HSL token, and import them in all four locations. Single source of truth for off-DOM color.
*(Consolidates the email/portal and OG-image token findings.)*

### 26. Document/centralize the heatmap's arbitrary values + success color
**Severity:** Medium · **Effort:** M
**Files:** `src/app/(app)/dashboard/best-windows-widget.tsx` (~L103 `gap-[2px]`, L161 `rounded-[2px]`, L163 `outline-emerald-500`, L165 `#10b981`)
**Change:** Define a `--positive`/success token (emerald-500) in `globals.css` and use `hsl(var(--positive))` for the heatmap fill instead of the hardcoded `#10b981`; make the outline use the same token so L163/L165 stop diverging (class vs raw hex). Add a comment explaining the `2px` radius/gap is an intentional density outlier off the `--radius` scale (or wrap in a `.surface-heatmap` class).
*(Consolidates the "emerald-500 hardcoded" and "arbitrary radius/spacing" heatmap findings.)*

### 27. Remove dead `prose` classes from legal pages
**Severity:** Low · **Effort:** S
**Files:** `src/app/privacy/page.tsx` (~L27), `src/app/terms/page.tsx` (~L27)
**Change:** `prose prose-sm` has no effect (the `@tailwindcss/typography` plugin isn't installed) — dead code; styling already comes from `text-sm leading-relaxed space-y-8`. Drop the two `prose` tokens.

### 28. Name the record-button error-glow shadow
**Severity:** Low · **Effort:** S
**Files:** `tailwind.config.ts`, `src/app/(app)/record/record-client.tsx` (~L265)
**Change:** Move `shadow-[0_0_0_8px_rgba(239,68,68,0.15)]` into the Tailwind theme as `shadow-error-glow` and reference it. Minor; single use.

### 29. Make `tabular-nums` explicit on metric values
**Severity:** Low · **Effort:** S
**Files:** `src/app/(app)/analytics/page.tsx` (~L103-107), `src/app/(app)/dashboard/page.tsx` (~L186-192, KpiCard sub ~L261)
**Change:** Some numeric values rely on inherited `tabular-nums`. Add it explicitly to each numeric span so refactors can't silently break alignment. (Honest note: `font-variant-numeric` inherits, so nothing is visually broken today — this is clarity/robustness only.)

---

## P3 — Navigation polish (all Low)

### 30. Workspace switcher needs an accessible name
**Severity:** Low · **Effort:** S
**Files:** `src/components/workspace-switcher.tsx` (~L36)
**Change:** Add `aria-label="Select workspace"` to the interactive `<select>` (the static branch has a `title`; the select doesn't).

### 31. Strengthen the active-nav cue and deep-page back links
**Severity:** Low · **Effort:** M
**Files:** `src/components/app-header.tsx` (~L79-83), `src/app/(app)/settings/organization/billing/page.tsx`, `.../organization/branding/page.tsx`
**Change:** Add `font-semibold` to active nav links (color-only is weak for color-vision-deficient users, and the 2px underline is faint). Separately, add the existing inline back-link pattern (from `settings/channels/[id]`) to 3-levels-deep pages like `/settings/organization/billing` and `/branding`, which currently have no parent path.

### 32. Record-page height magic number
**Severity:** Low · **Effort:** S
**Files:** `src/app/(app)/record/record-client.tsx` (~L185)
**Change:** `min-h-[calc(100vh-12rem)]` hardcodes the header+padding offset and breaks if the layout changes. Refactor to a flex column (`flex-1` child filling the remaining height) so it tracks header height automatically. Tech-debt, not a visible bug.

---

## Dropped (verified non-issues — do not action)

- **Submit-button loading "no pointer-event disable":** false — `Button` base class includes `disabled:pointer-events-none` + `disabled:opacity-50`, and all three call sites pass `disabled={pending}`. No safety gap. A spinner is optional polish only.
- **Video-keys vs reference-video error placement "mismatch":** finding's own verdict says the characterization is backwards and the placement is already consistent within those forms. No action.
- **Brief-form AI-fill feedback pattern:** verdict says it's good UX as-is; at most document it as a template.
- **Retire raster PNG icons:** PNGs are *actively used* (favicons/manifest/apple-touch) and are complementary to the UI logo, not duplicates. Only real item is regenerating them from the new SVG once Task 7 lands — fold into Task 7's follow-up, not a separate "remove unused assets" task.
- **Button height variance on landing (h-9/h-11):** verdict confirms this is intentional hierarchy; "standardize" would flatten it. Skip (at most add a code comment).
- **Heading-hierarchy `<hgroup>` on auth pages:** valid HTML already; enhancement-only, folded into Task 24/4.

---

### Suggested execution order
P0 (1–6) → Logo/brand/theme trio (7, 8, 9) → high responsive (11) → remaining P1 → P2 forms → P2 hygiene → P3. Tasks 7 and 8 are coupled (the logo tile consumes the brand-gradient token), so do 8 before/with 7.