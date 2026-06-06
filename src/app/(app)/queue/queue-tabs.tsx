"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

// Sub-nav for the Queue area. The main approval queue lives at /queue; Facebook
// Group Assist (a ToS-safe, copy-and-paste workflow that isn't part of the
// auto-publish pipeline) lives at /queue/groups. A thin tab strip keeps both in
// the same place without spending a top-nav slot.
const TABS = [
  { href: "/queue", label: "Approval queue" },
  { href: "/queue/groups", label: "Facebook Groups" },
];

export function QueueTabs() {
  const pathname = usePathname();
  return (
    <div className="flex items-center gap-1 border-b text-sm">
      {TABS.map((t) => {
        const active = pathname === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            className={cn(
              "relative -mb-px whitespace-nowrap rounded-t-md px-3 py-2 transition-colors duration-200",
              active
                ? "font-semibold text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            aria-current={active ? "page" : undefined}
          >
            {t.label}
            {active ? (
              <span
                aria-hidden
                className="absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-foreground"
              />
            ) : null}
          </Link>
        );
      })}
    </div>
  );
}
