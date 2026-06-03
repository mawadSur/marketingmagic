"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

// Settings hub sub-nav. The top nav collapsed Brief/Channels/Video keys/Events/
// Integrations/Billing/Team/Organization into a single "Settings" entry; this
// tab bar restores quick movement between them. Rendered above each settings
// page (the pages keep their own content/heading below).
//
// Integrations lives at /integrations (outside /settings), so it's a plain
// cross-link here; the rest are /settings/* and get this bar via the layout.
const settingsNav = [
  { href: "/settings/channels", label: "Channels" },
  { href: "/settings/brief", label: "Brief" },
  { href: "/settings/video-keys", label: "Video keys" },
  { href: "/settings/events", label: "Events" },
  { href: "/integrations", label: "Integrations" },
  { href: "/settings/billing", label: "Billing" },
  { href: "/settings/referrals", label: "Refer & earn" },
  { href: "/settings/team", label: "Team" },
  { href: "/settings/organization", label: "Organization" },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <>
      {/* Subordinate to the top nav: plain bg-background, no competing fill,
          a single bottom border for separation. The right-edge gradient mask
          hints at horizontally-scrollable tabs beyond the viewport. */}
      <div className="border-b bg-background">
        <div className="container relative">
          <div className="flex items-center gap-1 overflow-x-auto py-2 pr-8 text-sm">
            <span className="mr-2 hidden shrink-0 font-medium text-muted-foreground sm:inline">
              Settings
            </span>
            {settingsNav.map((item) => {
              const active = pathname === item.href || pathname.startsWith(item.href + "/");
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "shrink-0 whitespace-nowrap rounded-md px-2.5 py-1.5 transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                    active
                      ? "bg-muted font-medium text-foreground shadow-sm"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
          {/* Fade affordance: a gradient mask pinned to the right edge so hidden
              tabs are discoverable. Pointer-events-none so it never blocks taps. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-background to-transparent"
          />
        </div>
      </div>
      {children}
    </>
  );
}
