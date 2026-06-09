import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// ── Unit: pull-metrics cron persists the organic `saves` signal ──────────────
//
// Hormozi slice 1 (migration 059): dispatchMetrics already fetches IG `saves`
// into UnifiedMetrics, but the cron used to drop it. These tests drive the
// route with a mocked Supabase service + mocked dispatchMetrics and assert the
// post_metrics insert payload:
//   1. IG post → insert.saves === the dispatched saves value.
//   2. non-IG channel (saves undefined) → insert.saves === null
//      ("channel doesn't report saves", distinct from 0).

const env = { CRON_SECRET: "secret-cron-key-1234" };
vi.mock("@/lib/env", () => ({ serverEnv: () => env }));

// dispatchMetrics is mocked per-test so no channel API is touched.
const dispatchMetrics =
  vi.fn<(...args: unknown[]) => Promise<Record<string, number>>>();
vi.mock("@/lib/social/dispatch", () => ({
  dispatchMetrics: (...args: unknown[]) => dispatchMetrics(...args),
}));

// Supabase service stub. `posts` + `social_accounts` are read-only here;
// `post_metrics.insert` captures the payload the route builds.
let postRows: Array<{
  id: string;
  external_id: string | null;
  social_account_id: string | null;
  channel: string;
}> = [];
const insertedRows: Array<Record<string, unknown>> = [];

function selectChain(rows: unknown) {
  // A thenable-free chain that returns `{ data, error }` from any terminal
  // (.limit / .in) and stays chainable for the in-between filters the route
  // uses (.eq / .gte / .not).
  const result = { data: rows, error: null };
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "gte", "not", "in", "limit"]) {
    chain[m] = vi.fn(() => chain);
  }
  // Terminals the route awaits.
  chain.limit = vi.fn(() => result);
  chain.in = vi.fn(() => result);
  return chain;
}

vi.mock("@/lib/supabase/service", () => ({
  supabaseService: () => ({
    from: (table: string) => {
      if (table === "posts") return selectChain(postRows);
      if (table === "social_accounts") {
        return selectChain(
          postRows
            .filter((p) => p.social_account_id)
            .map((p) => ({ id: p.social_account_id, credentials: { token: "x" } })),
        );
      }
      if (table === "post_metrics") {
        return {
          insert: (row: Record<string, unknown>) => {
            insertedRows.push(row);
            return { error: null };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

import { POST } from "@/app/api/cron/pull-metrics/route";

function req(): NextRequest {
  return new NextRequest("https://app.test/api/cron/pull-metrics", {
    method: "POST",
    headers: { authorization: "Bearer secret-cron-key-1234" },
  });
}

beforeEach(() => {
  postRows = [];
  insertedRows.length = 0;
  dispatchMetrics.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("pull-metrics cron — persists saves", () => {
  it("maps dispatched IG saves → post_metrics.saves", async () => {
    postRows = [
      { id: "post-ig", external_id: "ig-1", social_account_id: "acct-ig", channel: "instagram" },
    ];
    dispatchMetrics.mockResolvedValue({
      impressions: 1000,
      likes: 50,
      comments: 5,
      shares: 3,
      clicks: 0,
      saves: 42,
    });

    const res = await POST(req());
    await res.json();

    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]!.post_id).toBe("post-ig");
    expect(insertedRows[0]!.saves).toBe(42);
  });

  it("non-IG channel (saves undefined) → null, not 0", async () => {
    postRows = [
      { id: "post-x", external_id: "x-1", social_account_id: "acct-x", channel: "x" },
    ];
    dispatchMetrics.mockResolvedValue({
      impressions: 200,
      likes: 10,
      comments: 1,
      shares: 0,
      clicks: 4,
      // no `saves` key — X doesn't report it
    });

    const res = await POST(req());
    await res.json();

    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]!.saves).toBeNull();
  });
});
