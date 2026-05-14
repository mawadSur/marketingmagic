"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Database } from "@/lib/db/types";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import { cn } from "@/lib/utils";

type Workspace = Database["public"]["Tables"]["workspaces"]["Row"];

const baseNav = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/analytics", label: "Analytics" },
  { href: "/plans", label: "Plans" },
  // Phase 2.5 — Source-to-Posts. Sits between Plans and Queue because the
  // mental model is: paste a source → generate a cluster → approve in queue.
  { href: "/sources", label: "Sources" },
  { href: "/queue", label: "Queue" },
  { href: "/settings/brief", label: "Brief" },
  { href: "/settings/channels", label: "Channels" },
  { href: "/settings/events", label: "Events" },
  { href: "/integrations", label: "Integrations" },
  { href: "/settings/billing", label: "Billing" },
];

// Portfolio only makes sense when the user is in ≥2 workspaces. We sneak
// it in right after Dashboard so the agency-lite users can flip between
// per-client and roll-up views without hunting.
function buildNav(showPortfolio: boolean) {
  if (!showPortfolio) return baseNav;
  return [
    baseNav[0],
    { href: "/portfolio", label: "Portfolio" },
    ...baseNav.slice(1),
  ];
}

function isActive(pathname: string, href: string): boolean {
  // Exact match, or prefix match if the nav item itself is a section root.
  if (pathname === href) return true;
  // /plans/[id] should keep /plans highlighted; /settings/channels/x keeps
  // /settings/channels highlighted. Special-case /settings/brief so /settings
  // alone doesn't double-light.
  return pathname.startsWith(href + "/");
}

export function AppHeader({ active, workspaces }: { active: Workspace; workspaces: Workspace[] }) {
  const pathname = usePathname();
  const nav = buildNav(workspaces.length >= 2);

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
