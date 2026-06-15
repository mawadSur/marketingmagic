// Shared state shape + initial value for the public handle checker.
//
// This lives OUTSIDE actions.ts on purpose: a "use server" file may only export
// async functions, so a re-exported type or a const object (initialCheckState)
// trips Next's runtime check ("can only export async functions, found object")
// even though the build passes. Keep non-function exports here.
import type { CachedAvailability } from "@/lib/handles/check";

export type CheckHandleState = {
  error: string | null;
  // The handle we actually checked (normalised), so the result can echo it.
  handle: string | null;
  availability: CachedAvailability[];
};

export const initialCheckState: CheckHandleState = {
  error: null,
  handle: null,
  availability: [],
};
