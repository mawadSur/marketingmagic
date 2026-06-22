"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { Menu, X, ArrowUpRight } from "lucide-react";
import { Logo } from "@/components/ui/logo";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type NavLink = { label: string; href: string };

// The default secondary links shown in the bar (desktop) and the drawer
// (mobile). Pages that ARE one of these (e.g. /pricing) pass their own set so
// they don't link to themselves.
const DEFAULT_LINKS: NavLink[] = [{ label: "Pricing", href: "/pricing" }];

export type SiteNavProps = {
  /** Secondary nav links. Defaults to a single "Pricing" link. */
  links?: NavLink[];
  loginHref?: string;
  signupHref?: string;
  signupLabel?: string;
};

/**
 * Shared marketing top-bar. One source of truth for the homepage, pricing, and
 * the public tools pages (previously this markup was duplicated inline across
 * all three, which is why mobile drifted out of sync).
 *
 * Desktop (md+): the links sit inline next to the auth actions.
 * Mobile (<md): the secondary links collapse behind a real hamburger that opens
 * an accessible, thumb-friendly drawer — generous 56px tap rows, focus trap,
 * Esc / backdrop / link-tap to close, body-scroll lock, and a staggered reveal
 * that echoes the site's aurora/glow motion. The primary "Sign up" CTA stays
 * visible in the bar so the conversion path is never more than one tap away.
 */
export function SiteNav({
  links = DEFAULT_LINKS,
  loginHref = "/login",
  signupHref = "/signup",
  signupLabel = "Sign up",
}: SiteNavProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Lock body scroll, wire Esc + a lightweight focus trap, and close when the
  // viewport grows past the mobile breakpoint (drawer is md-and-down only).
  useEffect(() => {
    if (!open) return;

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Capture the toggle now so the cleanup restores focus to the same node
    // (it's always mounted, so this is stable — keeps the linter happy too).
    const toggleEl = toggleRef.current;

    const mq = window.matchMedia("(min-width: 768px)");
    const onDesktop = () => mq.matches && setOpen(false);
    mq.addEventListener("change", onDesktop);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const focusables = panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);

    // Move focus into the panel on open.
    const firstLink = panelRef.current?.querySelector<HTMLElement>('a[href], button');
    firstLink?.focus();

    return () => {
      document.body.style.overflow = prevOverflow;
      mq.removeEventListener("change", onDesktop);
      document.removeEventListener("keydown", onKeyDown);
      // Restore focus to the toggle so keyboard users keep their place.
      toggleEl?.focus();
    };
  }, [open]);

  const drawerLinks: NavLink[] = [...links, { label: "Log in", href: loginHref }];

  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <nav className="container flex h-16 items-center justify-between gap-2">
        <Link
          href="/"
          aria-label="marketingmagic home"
          className="shrink-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          {/* Mark-only on the narrowest phones; full wordmark from sm up. */}
          <span className="inline-flex sm:hidden">
            <Logo variant="icon" size="sm" />
          </span>
          <span className="hidden sm:inline-flex">
            <Logo variant="full" size="sm" />
          </span>
        </Link>

        {/* Desktop: inline links + auth actions. */}
        <div className="hidden items-center gap-1 md:flex">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="inline-flex h-9 items-center whitespace-nowrap rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {l.label}
            </Link>
          ))}
          <Link
            href={loginHref}
            className="inline-flex h-9 items-center whitespace-nowrap rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            Log in
          </Link>
          <Button asChild size="sm" className="ml-1">
            <Link href={signupHref}>{signupLabel}</Link>
          </Button>
        </div>

        {/* Mobile: primary CTA stays visible, secondary nav goes behind the toggle. */}
        <div className="flex items-center gap-1 md:hidden">
          <Button asChild size="sm">
            <Link href={signupHref}>{signupLabel}</Link>
          </Button>
          <button
            ref={toggleRef}
            type="button"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((v) => !v)}
            className="relative inline-flex h-10 w-10 items-center justify-center rounded-md text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            {/* Morphing menu / close glyph. */}
            <Menu
              className={cn(
                "absolute h-5 w-5 transition-all duration-200 motion-reduce:transition-none",
                open ? "rotate-90 scale-75 opacity-0" : "rotate-0 scale-100 opacity-100",
              )}
              aria-hidden
            />
            <X
              className={cn(
                "absolute h-5 w-5 transition-all duration-200 motion-reduce:transition-none",
                open ? "rotate-0 scale-100 opacity-100" : "-rotate-90 scale-75 opacity-0",
              )}
              aria-hidden
            />
          </button>
        </div>
      </nav>

      {/* ── Mobile drawer ─────────────────────────────────────────────────── */}
      {/* Backdrop. Sits below the header (z-40) so the toggle stays tappable. */}
      <div
        aria-hidden
        onClick={() => setOpen(false)}
        className={cn(
          "fixed inset-0 top-16 z-30 bg-background/70 backdrop-blur-sm transition-opacity duration-200 md:hidden motion-reduce:transition-none",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />
      <div
        ref={panelRef}
        id={panelId}
        role="dialog"
        aria-modal="true"
        aria-label="Site menu"
        inert={!open || undefined}
        className={cn(
          "fixed inset-x-0 top-16 z-30 origin-top overflow-hidden border-b bg-background shadow-xl transition-all duration-200 ease-out md:hidden motion-reduce:transition-none",
          open
            ? "translate-y-0 opacity-100"
            : "pointer-events-none -translate-y-3 opacity-0",
        )}
      >
        {/* Decorative brand glow, echoing the hero. */}
        <div aria-hidden className="brand-glow pointer-events-none absolute inset-x-0 top-0 -z-10 h-24" />

        <div className="container flex flex-col gap-1 py-4">
          {drawerLinks.map((l, i) => (
            <Link
              key={l.href}
              href={l.href}
              onClick={() => setOpen(false)}
              style={{ transitionDelay: open ? `${60 + i * 45}ms` : "0ms" }}
              className={cn(
                "group flex min-h-14 items-center justify-between rounded-lg px-3 text-lg font-medium text-foreground transition-all duration-300 hover:bg-muted motion-reduce:transition-none",
                open ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0",
              )}
            >
              <span>{l.label}</span>
              <ArrowUpRight className="h-5 w-5 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" aria-hidden />
            </Link>
          ))}

          <div
            style={{ transitionDelay: open ? `${60 + drawerLinks.length * 45}ms` : "0ms" }}
            className={cn(
              "mt-3 transition-all duration-300 motion-reduce:transition-none",
              open ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0",
            )}
          >
            <Button asChild size="lg" className="h-14 w-full text-base">
              <Link href={signupHref} onClick={() => setOpen(false)}>
                {signupLabel}
              </Link>
            </Button>
          </div>
        </div>
      </div>
    </header>
  );
}
