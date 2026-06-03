"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Database } from "@/lib/db/types";
import { switchWorkspaceAction } from "@/app/(app)/workspace-actions";

type Workspace = Database["public"]["Tables"]["workspaces"]["Row"];

export function WorkspaceSwitcher({
  active,
  workspaces,
}: {
  active: Workspace;
  workspaces: Workspace[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  if (workspaces.length <= 1) {
    return (
      <span
        className="hidden items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-xs font-medium text-muted-foreground sm:inline-flex"
        title={active.name}
      >
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        {active.name}
      </span>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <div className="relative">
        <select
          aria-label="Select workspace"
          className="h-8 appearance-none rounded-md border bg-muted/40 pl-5 pr-7 text-xs font-medium text-foreground transition-colors duration-200 hover:bg-muted disabled:opacity-60"
          disabled={pending}
          value={active.slug}
          onChange={(event) => {
            const slug = event.target.value;
            start(async () => {
              await switchWorkspaceAction(slug);
              router.refresh();
            });
          }}
        >
          {workspaces.map((w) => (
            <option key={w.slug} value={w.slug}>
              {w.name}
            </option>
          ))}
        </select>
        <span
          aria-hidden
          className="pointer-events-none absolute left-2 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-emerald-500"
        />
        <svg
          aria-hidden
          viewBox="0 0 12 12"
          className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground"
        >
          <path
            d="M3 5l3 3 3-3"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <Link
        href="/workspaces/new"
        className="hidden text-xs text-muted-foreground transition-colors duration-200 hover:text-foreground sm:inline"
      >
        + New
      </Link>
    </div>
  );
}
