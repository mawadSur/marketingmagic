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
      <span className="rounded-md border px-2 py-1 text-xs font-medium text-muted-foreground">
        {active.name}
      </span>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <select
        className="h-8 rounded-md border bg-background px-2 text-sm"
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
      <Link
        href="/workspaces/new"
        className="text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        + New
      </Link>
    </div>
  );
}
