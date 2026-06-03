// Server-side design tokens.
//
// CSS custom properties in globals.css (e.g. --brand-grad-start) are the source
// of truth for the browser, but server-only renderers — Satori/`next/og` image
// generation and the report PDF — can't read CSS vars. They need plain hex.
// This module is the single place those literal values live so the OG card,
// the PDF, and the white-label portal stay in lockstep with the stylesheet.
//
// When you change a value here, change its matching globals.css token too.

// ─── Brand accent (indigo → violet gradient) ─────────────────────────────
// Mirrors globals.css `--brand-grad-start: 243 75% 59%` (indigo-600).
export const ACCENT_INDIGO = "#4f46e5";
// Mirrors globals.css `--brand-grad-end: 262 83% 58%` (violet-600).
export const ACCENT_VIOLET = "#7c3aed";

// ─── Neutral surfaces / text ─────────────────────────────────────────────
// Near-black ink. Tracks the dark end of globals.css `--foreground`.
export const NEUTRAL_DARK = "#0a0a0a";
// Slate-500 muted text. Tracks globals.css `--muted-foreground`.
export const TEXT_MUTED = "#64748b";

// ─── White-label portal defaults (branding.ts) ───────────────────────────
// Org owners can override these; they are the fallbacks when no color is set
// or a user-supplied value fails hex validation.
// Primary defaults to the neutral ink above.
export const PORTAL_DEFAULT_PRIMARY = NEUTRAL_DARK;
// Accent default is blue-600 (the historical portal default — distinct from the
// indigo/violet brand gradient, kept as-is to avoid changing rendered output).
export const PORTAL_DEFAULT_ACCENT = "#2563eb";

// ─── Open Graph preview card palette (opengraph-image.tsx) ────────────────
// A self-contained dark-slate + emerald palette for the shared-plan OG card.
// These are intentionally NOT the brand-gradient tokens; the card has its own
// look. Centralized here so the literals aren't buried in JSX.
export const OG_BG_GRADIENT =
  "linear-gradient(135deg, #0b1220 0%, #111827 55%, #1f2937 100%)";
export const OG_TEXT_PRIMARY = "#f8fafc"; // slate-50, main card text
export const OG_TEXT_MUTED = "#94a3b8"; // slate-400, secondary lines
export const OG_TEXT_SNIPPET = "#cbd5e1"; // slate-300, quoted snippet
export const OG_ACCENT_MINT = "#a7f3d0"; // emerald-200, wordmark row
export const OG_ACCENT_EMERALD = "#34d399"; // emerald-400, dot + rule
