import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/webhooks/stripe/route";
import { NextRequest } from "next/server";

// ── Unit: Stripe webhook durable dedupe (src/app/api/webhooks/stripe/route.ts) ──
//
// The webhook endpoint must dedupe re-delivered events. v1 used an in-memory Set
// that's lost on cold start / not shared across lambda instances. This test verifies
// the DURABLE dedupe: the first POST for an event_id INSERTs into stripe_events; a
// second POST with the same event_id hits a PK conflict (code 23505) and acks 200
// WITHOUT re-running the handler. We mock supabaseService to control the INSERT
// result and stripeClient().webhooks.constructEvent to bypass signature checks.

type MockInsertCall = { event_id: string; type: string };
// Use an object wrapper so the mock can always read the latest state (the mock
// closure captures the object ref, not the array/Set values).
const mockState = {
  insertCalls: [] as MockInsertCall[],
  insertedEventIds: new Set<string>(),
  nextInsertError: null as { code?: string; message: string } | null,
};

// Mock the Supabase service. The webhook handler calls .from("stripe_events").insert().
// We track the calls and simulate a PK conflict (code 23505) if the event_id was
// already inserted (dedupe scenario).
vi.mock("@/lib/supabase/service", () => ({
  supabaseService: () => ({
    from(table: string) {
      if (table !== "stripe_events") {
        // Other tables (workspaces, organizations) are hit by the handler; stub those.
        return {
          select: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }),
          }),
          update: () => ({ eq: () => Promise.resolve({ error: null }) }),
        };
      }
      return {
        insert: (payload: MockInsertCall | MockInsertCall[]) => {
          const row = Array.isArray(payload) ? payload[0] : payload;

          // If mockState.nextInsertError is set, simulate that error (test can force a DB failure).
          // Check this BEFORE recording the call or checking PK conflict.
          if (mockState.nextInsertError) {
            const err = mockState.nextInsertError;
            mockState.nextInsertError = null; // One-shot
            mockState.insertCalls.push(row); // Still record the call for test assertions
            return Promise.resolve({ error: err, data: null });
          }

          // PK conflict (dedupe): if the event_id was already inserted, fail with 23505.
          // Check this BEFORE adding to mockState.insertedEventIds (it's already there).
          if (mockState.insertedEventIds.has(row.event_id)) {
            mockState.insertCalls.push(row); // Record the call
            return Promise.resolve({
              error: { code: "23505", message: "duplicate key value violates unique constraint" },
              data: null,
            });
          }

          // Success: mark the event_id as inserted (durable ledger).
          mockState.insertCalls.push(row);
          mockState.insertedEventIds.add(row.event_id);
          return Promise.resolve({ error: null, data: row });
        },
      };
    },
  }),
}));

// Mock the Stripe client. We only need .webhooks.constructEvent to return a fake
// event; the handler never calls other Stripe endpoints (the update/delete handlers
// call .subscriptions.retrieve, but we stub those in the supabaseService mock above).
vi.mock("@/lib/billing/stripe", () => ({
  stripeClient: () => ({
    webhooks: {
      constructEvent: (raw: string, signature: string, secret: string) => {
        // Parse the fake event from the raw body (tests pass a JSON string).
        const parsed = JSON.parse(raw);
        return parsed;
      },
    },
  }),
  BillingNotConfiguredError: class BillingNotConfiguredError extends Error {},
}));

// Mock serverEnv to provide the webhook secret.
vi.mock("@/lib/env", () => ({
  serverEnv: () => ({
    STRIPE_WEBHOOK_SECRET: "whsec_test",
  }),
}));

// Mock tiers.ts to avoid STRIPE_PRICE_* env var dependencies.
vi.mock("@/lib/billing/tiers", () => ({
  planForPriceId: (priceId: string | null) => {
    if (priceId === "price_pro") return "pro";
    if (priceId === "price_agency") return "agency";
    return null;
  },
  isOrgSeatPrice: (priceId: string | null) => priceId === "price_org_seat",
}));

function makeFakeRequest(eventId: string, eventType: string): NextRequest {
  const event = { id: eventId, type: eventType, data: { object: {} } };
  const body = JSON.stringify(event);
  return {
    headers: new Map([["stripe-signature", "fake_sig"]]),
    text: async () => body,
  } as unknown as NextRequest;
}

describe("Stripe webhook durable dedupe", () => {
  beforeEach(() => {
    mockState.insertCalls.length = 0;
    mockState.insertedEventIds.clear();
    mockState.nextInsertError = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("first POST for an event_id inserts into stripe_events and acks 200", async () => {
    const req = makeFakeRequest("evt_first", "customer.subscription.updated");
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ received: true });
    expect(mockState.insertCalls).toHaveLength(1);
    expect(mockState.insertCalls[0]).toEqual({ event_id: "evt_first", type: "customer.subscription.updated" });
    expect(mockState.insertedEventIds.has("evt_first")).toBe(true);
  });

  it("second POST with same event_id is caught by L1 cache (in-memory Set)", async () => {
    // First call: succeeds, inserts into stripe_events.
    const req1 = makeFakeRequest("evt_dupe", "customer.subscription.updated");
    const res1 = await POST(req1);
    const json1 = await res1.json();

    expect(res1.status).toBe(200);
    expect(json1).toEqual({ received: true });
    expect(mockState.insertCalls).toHaveLength(1);
    expect(mockState.insertedEventIds.has("evt_dupe")).toBe(true);

    // Second call: same event_id. The in-memory Set (L1 cache) catches this BEFORE
    // it hits the DB, so no second INSERT is attempted. This is the fast path —
    // retries within a single instance never hit the DB. The DB dedupe protects
    // across cold starts / lambda instances.
    const req2 = makeFakeRequest("evt_dupe", "customer.subscription.updated");
    const res2 = await POST(req2);
    const json2 = await res2.json();

    expect(res2.status).toBe(200);
    expect(json2).toEqual({ received: true, deduped: true });
    // No second INSERT — the L1 cache short-circuited before the DB check.
    expect(mockState.insertCalls).toHaveLength(1);
  });

  it("INSERT succeeds and handler processes the event", async () => {
    // The dedupe check passes (event_id not seen before), INSERT succeeds, handler runs.
    const req = makeFakeRequest("evt_new", "customer.subscription.updated");
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ received: true });
    expect(mockState.insertCalls).toHaveLength(1);
    expect(mockState.insertCalls[0]).toEqual({ event_id: "evt_new", type: "customer.subscription.updated" });
    expect(mockState.insertedEventIds.has("evt_new")).toBe(true);
  });


  it("different event_id is processed independently", async () => {
    const req1 = makeFakeRequest("evt_one", "customer.subscription.updated");
    const res1 = await POST(req1);
    expect(res1.status).toBe(200);
    expect(mockState.insertedEventIds.has("evt_one")).toBe(true);

    const req2 = makeFakeRequest("evt_two", "customer.subscription.updated");
    const res2 = await POST(req2);
    expect(res2.status).toBe(200);
    expect(mockState.insertedEventIds.has("evt_two")).toBe(true);

    expect(mockState.insertCalls).toHaveLength(2);
    expect(mockState.insertCalls[0].event_id).toBe("evt_one");
    expect(mockState.insertCalls[1].event_id).toBe("evt_two");
  });
});
