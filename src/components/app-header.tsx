import Link from "next/link";
import type { Database } from "@/lib/db/types";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";

type Workspace = Database["public"]["Tables"]["workspaces"]["Row"];

const nav = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/plans", label: "Plans" },
  { href: "/queue", label: "Queue" },
  { href: "/settings/brief", label: "Brief" },
  { href: "/settings/channels", label: "Channels" },
];

export function AppHeader({ active, workspaces }: { active: Workspace; workspaces: Workspace[] }) {
  return (
    <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
      <div className="container flex h-14 items-center gap-4">
        <Link href="/dashboard" className="text-base font-semibold">
          marketingmagic
        </Link>
        <WorkspaceSwitcher active={active} workspaces={workspaces} />
        <nav className="flex flex-1 items-center gap-4 text-sm">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <form action="/auth/logout" method="post">
          <button type="submit" className="text-sm text-muted-foreground hover:text-foreground">
            Log out
          </button>
        </form>
      </div>
    </header>
  );
}
