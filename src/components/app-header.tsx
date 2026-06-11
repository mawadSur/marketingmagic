"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Database } from "@/lib/db/types";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import { Logo } from "@/components/ui/logo";
import { cn } from "@/lib/utils";

// Codebase-standard keyboard focus ring (see brand brief).
const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

type Workspace = Database["public"]["Tables"]["workspaces"]["Row"];

// Consolidated top nav — was 16 flat, horizontally-scrolling items. Now 7:
//   • Settings absorbs Brief, Channels, Video keys, Events, Integrations,
//     Billing, Team & Organization (see the settings sub-nav / layout).
//   • Goals + Sources are entry points on the Plans page.
//   • Competitors + Portfolio are tabs on the Analytics page.
// /settings prefix-matches in isActive(), so any settings sub-page keeps
// "Settings" lit; likewise /plans, /analytics for their sub-routes.
const nav = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/plans", label: "Plans" },
  { href: "/queue", label: "Queue" },
  { href: "/video", label: "Video" },
  { href: "/inbox", label: "Inbox" },
  { href: "/analytics", label: "Analytics" },
  { href: "/handles", label: "Handles" },
  { href: "/settings", label: "Settings" },
];

function isActive(pathname: string, href: string): boolean {
  // Exact match, or prefix match if the nav item itself is a section root.
  if (pathname === href) return true;
  // /plans/[id] should keep /plans highlighted; /settings/channels/x keeps
  // /settings/channels highlighted. Special-case /settings/brief so /settings
  // alone doesn't double-light.
  return pathname.startsWith(href + "/");
}

export function AppHeader({
  active,
  workspaces,
}: {
  active: Workspace;
  workspaces: Workspace[];
  isOwner?: boolean; // accepted for caller compat; the top nav no longer owner-gates
}) {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-14 items-center gap-3 sm:gap-4">
        <Link
          href="/dashboard"
          aria-label="Go to dashboard"
          className={cn(
            "flex items-center gap-2 rounded-md text-base font-semibold transition-opacity duration-200 hover:opacity-80",
            FOCUS_RING,
          )}
        >
          <Logo variant="icon" size="md" />
          <span className="hidden font-semibold tracking-tight sm:inline">
            marketingmagic
          </span>
        </Link>
        <WorkspaceSwitcher active={active} workspaces={workspaces} />
        {/* Right-edge fade affordance: on mobile the 7 nav items scroll past
            the viewport, so a gradient mask signals there's more to swipe.
            Right-only (not the both-edge .marquee-mask) so the left-anchored
            "Dashboard" label is never clipped. Removed at sm+ where all fit. */}
        <nav
          className="flex flex-1 items-center gap-1 overflow-x-auto text-sm [-webkit-mask-image:linear-gradient(to_right,black_85%,transparent)] [mask-image:linear-gradient(to_right,black_85%,transparent)] sm:[-webkit-mask-image:none] sm:[mask-image:none]"
        >
          {nav.map((item) => {
            const activeRoute = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "relative whitespace-nowrap rounded-md px-1.5 py-1.5 transition-colors duration-200 sm:px-2.5",
                  FOCUS_RING,
                  activeRoute
                    ? "font-semibold text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
                aria-current={activeRoute ? "page" : undefined}
              >
                {item.label}
                {activeRoute ? (
                  <span
                    aria-hidden
                    className="absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-foreground"
                  />
                ) : null}
              </Link>
            );
          })}
        </nav>
        <form action="/auth/logout" method="post">
          <button
            type="submit"
            className={cn(
              "rounded-md text-sm text-muted-foreground transition-colors duration-200 hover:text-foreground",
              FOCUS_RING,
            )}
          >
            Log out
          </button>
        </form>
      </div>
    </header>
  );
}
