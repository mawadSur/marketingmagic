"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { resolvePortalToken } from "@/lib/portal/token";
import { approvePostViaPortal, rejectPostViaPortal } from "@/lib/portal/data";
import type { RejectionReason } from "@/lib/db/types";

// ─────────────────────────────────────────────────────────────
// Client portal — token-authenticated server actions (Phase D)
// ─────────────────────────────────────────────────────────────
//
// SECURITY: the raw token is the ONLY credential. Every action re-resolves it
// server-side on each call (resolvePortalToken validates not-revoked +
// not-expired and yields the workspace + scopes) — we never trust a workspace
// id or scope passed from the client. The DAL functions re-assert the scope and
// workspace, so even a forged postId from another workspace resolves to null.

type ActionResult = { error: string | null };

const uuid = z.string().uuid();

const rejectionReasonSchema = z.enum([
  "off_voice",
  "wrong_theme",
  "factually_wrong",
  "other",
]);
const reasonNoteSchema = z
  .string()
  .trim()
  .max(500)
  .optional()
  .transform((s) => (s && s.length > 0 ? s : null));

export async function portalApproveAction(
  rawToken: string,
  postId: string,
): Promise<ActionResult> {
  if (!uuid.safeParse(postId).success) return { error: "Bad post id." };

  const ctx = await resolvePortalToken(rawToken);
  if (!ctx) return { error: "This link is no longer valid." };

  const result = await approvePostViaPortal(ctx, postId);
  if (!result.error) revalidatePath(`/client/${rawToken}`);
  return result;
}

export async function portalRejectAction(
  rawToken: string,
  postId: string,
  reason: RejectionReason,
  reasonNote?: string,
): Promise<ActionResult> {
  if (!uuid.safeParse(postId).success) return { error: "Bad post id." };
  const reasonParsed = rejectionReasonSchema.safeParse(reason);
  if (!reasonParsed.success) return { error: "Pick a rejection reason." };
  const noteParsed = reasonNoteSchema.safeParse(reasonNote);
  if (!noteParsed.success) return { error: "Note must be 500 chars or fewer." };

  const ctx = await resolvePortalToken(rawToken);
  if (!ctx) return { error: "This link is no longer valid." };

  const result = await rejectPostViaPortal(ctx, postId, reasonParsed.data, noteParsed.data);
  if (!result.error) revalidatePath(`/client/${rawToken}`);
  return result;
}
