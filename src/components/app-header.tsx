"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Database } from "@/lib/db/types";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import { cn } from "@/lib/utils";

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
          className="flex items-center gap-2 text-base font-semibold transition-opacity duration-200 hover:opacity-80"
        >
          <span
            aria-hidden
            className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-foreground to-foreground/70 text-[10px] font-bold text-background"
          >
            mm
          </span>
          <span className="hidden sm:inline">marketingmagic</span>
        </Link>
        <WorkspaceSwitcher active={active} workspaces={workspaces} />
        <nav className="flex flex-1 items-center gap-1 overflow-x-auto text-sm">
          {nav.map((item) => {
            const activeRoute = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "relative whitespace-nowrap rounded-md px-2.5 py-1.5 transition-colors duration-200",
                  activeRoute
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
                aria-current={activeRoute ? "page" : undefined}
              >
                {item.label}
                {activeRoute ? (
                  <span
                    aria-hidden
                    className="absolute inset-x-2 -bottom-[15px] h-[2px] rounded-full bg-foreground"
                  />
                ) : null}
              </Link>
            );
          })}
        </nav>
        <form action="/auth/logout" method="post">
          <button
            type="submit"
            className="text-sm text-muted-foreground transition-colors duration-200 hover:text-foreground"
          >
            Log out
          </button>
        </form>
      </div>
    </header>
  );
}
