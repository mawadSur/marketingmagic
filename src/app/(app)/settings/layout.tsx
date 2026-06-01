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
      <div className="border-b bg-muted/30">
        <div className="container flex items-center gap-1 overflow-x-auto py-2 text-sm">
          <span className="mr-2 shrink-0 font-medium text-muted-foreground">Settings</span>
          {settingsNav.map((item) => {
            const active = pathname === item.href || pathname.startsWith(item.href + "/");
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "shrink-0 whitespace-nowrap rounded-md px-2.5 py-1.5 transition-colors",
                  active
                    ? "bg-background font-medium text-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      </div>
      {children}
    </>
  );
}
