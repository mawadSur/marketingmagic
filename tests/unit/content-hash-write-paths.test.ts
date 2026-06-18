import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Unit: content_hash is written/refreshed on every posts write path ─────────
//
// Review found the dedup gate's EXACT-match path can be bypassed when a write
// path mutates posts.text but leaves a STALE (or missing) content_hash: a true
// exact-dup of the new body then slips through to scheduling / auto-publish.
//
// These tests pin the invariant for the three actions that were patched — for
// each one the UPDATE/INSERT payload must carry content_hash === hashContent of
// the EXACT text that lands in the row (post-truncation, post-tag-rewrite, etc).
// We use the REAL hashContent so a drift in either the action or the hash helper
// is caught; everything else (Supabase client, workspace, heavy AI/billing deps)
// is mocked.

import { hashContent } from "@/lib/dedup/similarity";

// ── Shared Supabase chain recorder ────────────────────────────────────────────
//
// from("posts").update({...}).eq(...) and
// from("posts").insert({...}).select(...).single() both record their payload so
// a test can assert what was persisted. from("approvals").insert(...) and the
// social_accounts_safe probe are stubbed to succeed.
const {
  postsUpdate,
  postsUpdateEq,
  postsInsert,
  approvalsInsert,
  acctMaybeSingle,
  loadMaybeSingle,
  revalidatePath,
} = vi.hoisted(() => ({
  postsUpdate: vi.fn(),
  postsUpdateEq: vi.fn(async () => ({ error: null as null | { message: string } })),
  postsInsert: vi.fn(),
  approvalsInsert: vi.fn(async () => ({ error: null })),
  acctMaybeSingle: vi.fn(async () => ({ data: { id: "acct-1" }, error: null })),
  loadMaybeSingle: vi.fn(async () => ({
    data: null as null | Record<string, unknown>,
    error: null as null | { message: string },
  })),
  revalidatePath: vi.fn(),
}));

function makeServerClient() {
  return {
    from: (table: string) => {
      if (table === "approvals") {
        return { insert: approvalsInsert };
      }
      if (table === "social_accounts_safe") {
        return {
          select: () => ({
            eq: () => ({ eq: () => ({ eq: () => ({ maybeSingle: acctMaybeSingle }) }) }),
          }),
        };
      }
      // posts
      return {
        select: () => ({
          eq: () => ({ eq: () => ({ maybeSingle: loadMaybeSingle }) }),
        }),
        update: (...args: unknown[]) => {
          postsUpdate(...args);
          return { eq: postsUpdateEq };
        },
        insert: (...args: unknown[]) => {
          postsInsert(...args);
          return { select: () => ({ single: async () => ({ data: { id: "new-post" }, error: null }) }) };
        },
      };
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({ supabaseServer: async () => makeServerClient() }));
vi.mock("@/lib/supabase/service", () => ({ supabaseService: () => makeServerClient() }));
vi.mock("@/lib/workspace", () => ({
  getActiveWorkspaceOrRedirect: async () => ({ id: "ws-1" }),
  getAuthedUserOrRedirect: async () => ({ id: "user-1" }),
}));
vi.mock("next/cache", () => ({ revalidatePath }));

// Heavy / side-effecting deps pulled in transitively by queue/actions.ts. None
// are exercised by editPostAction, but their module-load must not break the
// node test env, so stub them out.
vi.mock("@/lib/images", () => ({ defaultImageProvider: () => ({}) }));
vi.mock("@/lib/brand/load", () => ({ loadBrandStyle: async () => ({}) }));
vi.mock("@/lib/brand/style", () => ({ applyBrandStyleToPrompt: (p: string) => p }));
vi.mock("@/lib/tags/persist", () => ({ generateAndStoreTagsForPost: async () => null }));
vi.mock("@/lib/billing/limits", () => ({
  assertWithinImageQuota: async () => undefined,
  QuotaExceededError: class extends Error {},
}));
vi.mock("@/lib/billing/usage", () => ({ incrementImagesGenerated: async () => undefined }));
vi.mock("@/lib/experiments/run", () => ({ runQuickExperiment: async () => ({ experimentId: "x" }) }));
vi.mock("@/lib/social/dispatch", () => ({ dispatchPost: async () => ({ externalId: "e" }) }));
vi.mock("@/lib/growth/attribution", () => ({ applyAttribution: async (_s: unknown, _w: unknown, t: string) => t }));
vi.mock("@/lib/growth/referrals", () => ({ vestReferralOnFirstPost: async () => undefined }));

import { editPostAction } from "@/app/(app)/queue/actions";
import { createDraftPostAction } from "@/app/(app)/queue/compose-actions";
import { editThreadTweetAction } from "@/app/(app)/queue/thread-actions";

const VALID_UUID = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  postsUpdateEq.mockResolvedValue({ error: null });
  acctMaybeSingle.mockResolvedValue({ data: { id: "acct-1" }, error: null });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("editPostAction — refreshes content_hash with the new text", () => {
  it("writes content_hash = hashContent(newText) alongside the edited body", async () => {
    const newText = "Big news today: we just shipped dark mode. Try it now!";
    loadMaybeSingle.mockResolvedValueOnce({
      data: { id: VALID_UUID, text: "old body", channel: "x", status: "pending_approval" },
      error: null,
    });

    const res = await editPostAction(VALID_UUID, newText);
    expect(res.error).toBeNull();

    const payload = postsUpdate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.text).toBe(newText);
    expect(payload.content_hash).toBe(hashContent(newText));
    // A stale hash would equal the OLD body's hash — guard against the bug.
    expect(payload.content_hash).not.toBe(hashContent("old body"));
  });
});

describe("createDraftPostAction — stamps content_hash on insert", () => {
  it("inserts content_hash = hashContent(text) on the new draft", async () => {
    const text = "A brand new compose-flow post that should be deduped later";
    const res = await createDraftPostAction({ channel: "x", text });
    expect(res.error).toBeNull();

    const payload = postsInsert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.text).toBe(text);
    expect(payload.content_hash).toBe(hashContent(text));
  });
});

describe("editThreadTweetAction — refreshes content_hash with the new tweet", () => {
  it("writes content_hash = hashContent(newText) for the edited tweet", async () => {
    const newText = "Tweet one of the thread, freshly rewritten by the author";
    loadMaybeSingle.mockResolvedValueOnce({
      data: {
        id: VALID_UUID,
        text: "old tweet",
        channel: "x",
        status: "pending_approval",
        generation_metadata: {
          thread: { is_thread: true, tweet_index: 2, total_tweets: 3, role: "body" },
        },
      },
      error: null,
    });

    const res = await editThreadTweetAction(VALID_UUID, newText);
    expect(res.error).toBeNull();

    const payload = postsUpdate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.text).toBe(newText);
    expect(payload.content_hash).toBe(hashContent(newText));
  });
});
