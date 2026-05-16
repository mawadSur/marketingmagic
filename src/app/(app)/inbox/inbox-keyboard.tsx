"use client";

import { useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { snoozeInteractionAction, dismissInteractionAction } from "./actions";

// Phase 4.5 — keyboard navigation for /inbox.
//
// Mounts once at the top of /inbox and listens at the document level.
// Bindings:
//   j / k  — move focus / selection up & down
//   r      — open the detail page (reply)
//   s      — snooze for 24h
//   x      — dismiss
//
// Selection state is "currently-focused row id" tracked on a single
// data-attribute on each row (data-interaction-id). We start on row 0
// and clamp at the ends.

interface InboxKeyboardProps {
  interactionIds: string[];
}

export function InboxKeyboard({ interactionIds }: InboxKeyboardProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const indexRef = useRef(0);

  // Highlight a row by id. We touch a data-attribute the row reads via
  // a CSS selector — no React re-render needed for the focus ring.
  function highlight(id: string | null) {
    const rows = document.querySelectorAll<HTMLElement>("[data-interaction-id]");
    rows.forEach((r) => {
      if (r.dataset.interactionId === id) {
        r.setAttribute("data-focused", "true");
        // Keep the focused row in view as we j/k through a long list.
        r.scrollIntoView({ block: "nearest" });
      } else {
        r.removeAttribute("data-focused");
      }
    });
  }

  useEffect(() => {
    if (interactionIds.length === 0) return;
    // Re-highlight after navigation.
    highlight(interactionIds[indexRef.current] ?? interactionIds[0] ?? null);
  }, [interactionIds]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Don't intercept while typing in inputs/textareas.
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (interactionIds.length === 0) return;
      const current = interactionIds[indexRef.current] ?? interactionIds[0];

      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        indexRef.current = Math.min(interactionIds.length - 1, indexRef.current + 1);
        highlight(interactionIds[indexRef.current] ?? null);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        indexRef.current = Math.max(0, indexRef.current - 1);
        highlight(interactionIds[indexRef.current] ?? null);
      } else if (e.key === "r" || e.key === "Enter") {
        e.preventDefault();
        if (!current) return;
        router.push(`/inbox/${current}`);
      } else if (e.key === "s") {
        e.preventDefault();
        if (!current) return;
        startTransition(async () => {
          await snoozeInteractionAction(current);
          router.refresh();
        });
      } else if (e.key === "x") {
        e.preventDefault();
        if (!current) return;
        startTransition(async () => {
          await dismissInteractionAction(current);
          router.refresh();
        });
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [interactionIds, router]);

  return null;
}
