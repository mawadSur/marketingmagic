// The single marketingmagic brand mark. Replaces the three divergent logos that
// existed before (a Sparkles glyph in a violet square on marketing, a "mm" text
// badge in app/auth, and a raster monogram in the icon assets). One adaptive
// SVG, used everywhere.
//
// The mark is a four-arch "mm" monogram drawn with `currentColor`, so it takes
// the color of its context. Two variants:
//   icon — the glyph inside a rounded brand-gradient tile (white glyph). The
//          compact brand badge for nav/header/auth.
//   full — the same tile + the "marketingmagic" wordmark beside it.
//
// Sizes are a fixed scale so the badge is consistent across surfaces:
//   sm = 24px tile (marketing nav, footer)
//   md = 32px tile (app header)
//   lg = 40px tile (auth pages, centered)

import { cn } from "@/lib/utils";

export const LOGO_SIZES = {
  sm: { tile: "h-6 w-6 rounded-md", glyph: "h-3.5 w-3.5", text: "text-sm" },
  md: { tile: "h-8 w-8 rounded-lg", glyph: "h-5 w-5", text: "text-base" },
  lg: { tile: "h-10 w-10 rounded-lg", glyph: "h-6 w-6", text: "text-lg" },
} as const;

type LogoSize = keyof typeof LOGO_SIZES;

// The raw mm monogram. Inherits color via `currentColor` (stroke). Kept inline
// so it can be a single-color glyph that adapts to light/dark/brand contexts
// without shipping multiple raster files.
function MmGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 66 34"
      fill="none"
      className={className}
      aria-hidden
      focusable="false"
    >
      <path
        d="M5 29 L5 16 A6.5 6.5 0 0 1 18 16 L18 29 M18 16 A6.5 6.5 0 0 1 31 16 L31 29 M37 29 L37 16 A6.5 6.5 0 0 1 50 16 L50 29 M50 16 A6.5 6.5 0 0 1 63 16 L63 29"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Logo({
  variant = "full",
  size = "md",
  className,
}: {
  variant?: "icon" | "full";
  size?: LogoSize;
  className?: string;
}) {
  const s = LOGO_SIZES[size];
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span
        aria-hidden
        className={cn(
          "brand-gradient inline-flex items-center justify-center text-white",
          s.tile,
        )}
      >
        <MmGlyph className={s.glyph} />
      </span>
      {variant === "full" ? (
        <span className={cn("font-semibold tracking-tight", s.text)}>
          marketingmagic
        </span>
      ) : null}
    </span>
  );
}
