"use client";

// Indeterminate top loading bar. Driven by the workspace switcher's `pending`
// transition so there's clear feedback during the switch round-trip (the server
// action that flips the active-workspace cookie + the router.refresh that
// re-renders the whole app shell for the new workspace). Fixed to the viewport
// top (z-50, above the sticky app header at z-10), so its position in the tree
// doesn't matter. Reduced-motion users get a static full-width bar (see
// globals.css .mm-progress-bar).
export function TopProgressBar({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <div
      role="progressbar"
      aria-busy="true"
      aria-label="Switching workspace"
      className="fixed inset-x-0 top-0 z-50 h-[3px] overflow-hidden bg-primary/10"
    >
      <span
        aria-hidden
        className="mm-progress-bar brand-gradient absolute inset-y-0 left-0 w-1/4 rounded-r-full"
      />
    </div>
  );
}
