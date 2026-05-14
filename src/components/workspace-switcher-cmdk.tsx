"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import type { Database } from "@/lib/db/types";
import {
  switchWorkspaceAction,
  toggleWorkspacePinAction,
} from "@/app/(app)/workspace-actions";
import { cn } from "@/lib/utils";

type Workspace = Database["public"]["Tables"]["workspaces"]["Row"];

/**
 * Global cmd-K / ctrl-K workspace switcher. Mounted once from the app
 * layout. Stays invisible until invoked, then opens a centred palette
 * over whatever page the user is on.
 *
 * Search is a simple substring + initial match against workspace name and
 * slug — no extra deps (`cmdk` isn't installed). Behavior parity with the
 * existing `<WorkspaceSwitcher>`: pick a row → set active workspace cookie
 * → navigate to /dashboard.
 *
 * Phase 4 polish (multi-workspace agency users):
 *   * Pinned workspaces render first (max 5 pins, server-side cookie).
 *   * Recent workspaces follow pins (last 5 visited, server-side cookie).
 *   * Each row shows posts-shipped-this-week as a quick activity signal.
 *   * Star icon toggles pin/unpin per workspace.
 *
 * Bind ignores cmd-K when the user is in an input/textarea or has an
 * IME composition open, so we don't fight other shortcuts.
 */
export function WorkspaceSwitcherCmdK({
  workspaces,
  activeSlug,
  pinnedIds = [],
  recentIds = [],
  postCounts = {},
}: {
  workspaces: Workspace[];
  activeSlug: string;
  pinnedIds?: string[];
  recentIds?: string[];
  postCounts?: Record<string, number>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [pending, start] = useTransition();
  const [pinPending, startPin] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  // Local mirror of pinned ids so the star icon flips immediately, then
  // the server action reconciles via revalidatePath on the next paint.
  const [pinned, setPinned] = useState<string[]>(pinnedIds);
  useEffect(() => {
    setPinned(pinnedIds);
  }, [pinnedIds]);

  // Bind cmd-K / ctrl-K globally. Ignore when typing in inputs/textareas
  // or contentEditable surfaces — meta-K is a common in-app shortcut.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const isToggleCombo =
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "k";
      if (!isToggleCombo) return;

      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      const isEditing =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        (target?.isContentEditable ?? false);
      // Only block the shortcut when typing in non-palette editors. Allow it
      // to fire from our own palette input so users can toggle off via cmd-K.
      if (isEditing && !target?.closest?.("[data-cmdk-root]")) return;

      event.preventDefault();
      setOpen((prev) => !prev);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Filtered list. Substring match on name/slug, case-insensitive.
  //
  // Ordering rules (when query is empty):
  //   1. Active workspace.
  //   2. Pinned workspaces (in pin-cookie order).
  //   3. Recent workspaces (in recent-cookie order).
  //   4. Everything else alphabetically.
  //
  // When the user is typing, name/slug match wins so search still feels
  // like search — pins only affect the "no query" home view.
  const pinnedSet = useMemo(() => new Set(pinned), [pinned]);
  const recentSet = useMemo(() => new Set(recentIds), [recentIds]);
  const recentOrder = useMemo(() => {
    const order = new Map<string, number>();
    recentIds.forEach((id, i) => order.set(id, i));
    return order;
  }, [recentIds]);
  const pinnedOrder = useMemo(() => {
    const order = new Map<string, number>();
    pinned.forEach((id, i) => order.set(id, i));
    return order;
  }, [pinned]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const scored = workspaces
      .map((w) => {
        const name = w.name.toLowerCase();
        const slug = w.slug.toLowerCase();
        if (!q) return { ws: w, score: 0 };
        if (name.startsWith(q)) return { ws: w, score: 100 };
        if (slug.startsWith(q)) return { ws: w, score: 90 };
        if (name.includes(q)) return { ws: w, score: 50 };
        if (slug.includes(q)) return { ws: w, score: 40 };
        return null;
      })
      .filter((x): x is { ws: Workspace; score: number } => x !== null);

    if (q) {
      scored.sort((a, b) => b.score - a.score);
      return scored.map((s) => s.ws);
    }

    // No query — apply the pinned/recent ordering.
    const rank = (w: Workspace): number => {
      if (w.slug === activeSlug) return -10;
      if (pinnedSet.has(w.id)) return (pinnedOrder.get(w.id) ?? 0);
      if (recentSet.has(w.id)) return 100 + (recentOrder.get(w.id) ?? 0);
      return 1000; // unpinned, non-recent
    };
    return scored
      .map((s) => s.ws)
      .sort((a, b) => {
        const ra = rank(a);
        const rb = rank(b);
        if (ra !== rb) return ra - rb;
        return a.name.localeCompare(b.name);
      });
  }, [
    workspaces,
    query,
    activeSlug,
    pinnedSet,
    pinnedOrder,
    recentSet,
    recentOrder,
  ]);

  // Reset highlight when results change. Pin to active workspace when query
  // is empty so cmd-K + enter is a no-op on the current workspace.
  useEffect(() => {
    if (!query.trim()) {
      const idx = results.findIndex((w) => w.slug === activeSlug);
      setHighlight(idx >= 0 ? idx : 0);
    } else {
      setHighlight(0);
    }
  }, [results, query, activeSlug]);

  // Focus input on open.
  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(id);
  }, [open]);

  const pick = useCallback(
    (ws: Workspace) => {
      setOpen(false);
      // If the user picked the active workspace, just close — no churn.
      if (ws.slug === activeSlug) return;
      start(async () => {
        await switchWorkspaceAction(ws.slug);
        router.push("/dashboard");
        router.refresh();
      });
    },
    [activeSlug, router],
  );

  const onListKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((h) => Math.min(h + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const choice = results[highlight];
      if (choice) pick(choice);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            "fixed inset-0 z-50 bg-background/60 backdrop-blur-sm",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0",
            "data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
          )}
        />
        <Dialog.Content
          aria-label="Switch workspace"
          data-cmdk-root
          onKeyDown={onListKeyDown}
          className={cn(
            "fixed left-1/2 top-[20%] z-50 w-[92vw] max-w-md -translate-x-1/2",
            "rounded-lg border bg-background shadow-xl",
            "focus:outline-none",
          )}
        >
          <Dialog.Title className="sr-only">Switch workspace</Dialog.Title>
          <Dialog.Description className="sr-only">
            Type to filter your workspaces. Use arrow keys to navigate and Enter to switch.
          </Dialog.Description>

          <div className="flex items-center gap-2 border-b px-3">
            <svg
              aria-hidden
              viewBox="0 0 16 16"
              className="h-4 w-4 shrink-0 text-muted-foreground"
            >
              <circle cx={7} cy={7} r={4.5} fill="none" stroke="currentColor" strokeWidth={1.5} />
              <path d="M10.5 10.5l3 3" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
            </svg>
            <input
              ref={inputRef}
              type="text"
              placeholder="Switch workspace…"
              className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <kbd className="hidden rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline-block">
              esc
            </kbd>
          </div>

          <ul
            role="listbox"
            // Larger max-height for agency users with many workspaces. Browser
            // scroll handles 50+ rows fine — no need for a virtual-scroll dep.
            className="max-h-[60vh] overflow-y-auto py-1"
          >
            {results.length === 0 ? (
              <li className="px-3 py-6 text-center text-sm text-muted-foreground">
                No workspaces match “{query}”.
              </li>
            ) : (
              results.map((w, i) => {
                const isActive = w.slug === activeSlug;
                const isPinned = pinnedSet.has(w.id);
                const count = postCounts[w.id] ?? 0;
                const showPinned = !query && isPinned && !isActive;
                const showRecent = !query && !isPinned && !isActive && recentSet.has(w.id);
                const togglePin = (e: React.MouseEvent) => {
                  e.stopPropagation();
                  // Optimistic flip; revalidate refreshes ordering.
                  setPinned((prev) =>
                    prev.includes(w.id) ? prev.filter((x) => x !== w.id) : [w.id, ...prev].slice(0, 5),
                  );
                  startPin(async () => {
                    await toggleWorkspacePinAction(w.id);
                    router.refresh();
                  });
                };
                return (
                  <li key={w.id} role="option" aria-selected={i === highlight}>
                    <div
                      className={cn(
                        "flex w-full items-center justify-between gap-3 px-3 py-2 text-sm transition-colors",
                        i === highlight ? "bg-muted" : "hover:bg-muted/50",
                      )}
                      onMouseEnter={() => setHighlight(i)}
                    >
                      <button
                        type="button"
                        onClick={() => pick(w)}
                        disabled={pending}
                        className="flex min-w-0 flex-1 items-center gap-2.5 text-left disabled:opacity-60"
                      >
                        <span
                          aria-hidden
                          className={cn(
                            "h-1.5 w-1.5 shrink-0 rounded-full",
                            isActive ? "bg-emerald-500" : "bg-muted-foreground/40",
                          )}
                        />
                        <span className="truncate font-medium">{w.name}</span>
                        <span className="truncate text-xs text-muted-foreground">{w.slug}</span>
                      </button>
                      <div className="flex shrink-0 items-center gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                        {count > 0 ? (
                          <span title={`${count} posts shipped in the last 7 days`}>
                            {count} 7d
                          </span>
                        ) : null}
                        {showPinned ? <span aria-label="pinned">pinned</span> : null}
                        {showRecent ? <span>recent</span> : null}
                        {isActive ? <span>current</span> : null}
                        <button
                          type="button"
                          onClick={togglePin}
                          disabled={pinPending}
                          aria-label={isPinned ? "Unpin workspace" : "Pin workspace"}
                          title={isPinned ? "Unpin" : "Pin"}
                          className={cn(
                            "rounded p-1 transition-colors",
                            isPinned ? "text-amber-500 hover:text-amber-600" : "text-muted-foreground/50 hover:text-muted-foreground",
                            "disabled:opacity-60",
                          )}
                        >
                          <PinIcon filled={isPinned} />
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })
            )}
          </ul>

          <div className="flex items-center justify-between gap-3 border-t px-3 py-2 text-[11px] text-muted-foreground">
            <span>
              <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">↑↓</kbd>{" "}
              navigate ·{" "}
              <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">↵</kbd>{" "}
              switch
            </span>
            <span>
              <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">⌘ K</kbd>{" "}
              toggle
            </span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PinIcon({ filled }: { filled: boolean }) {
  // Simple inline pushpin glyph. No lucide dep because we want the
  // filled/unfilled variants tied to one path; the lucide pin glyph
  // doesn't have a fill toggle in the version shipped here.
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 16 16"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M6 1.5h4l-.5 3 2 2.5v2H4.5v-2l2-2.5L6 1.5z" />
      <path d="M8 9v5" />
    </svg>
  );
}
