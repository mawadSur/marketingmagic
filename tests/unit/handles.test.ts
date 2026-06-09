import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Unit: handle-finder pipeline (src/lib/handles/*) ─────────────────────────
//
// Covers the three pure layers (no DB):
//   1. platforms — format validation + profile/claim URL builders + normalise.
//   2. schema    — candidate normalisation + dedupe.
//   3. availability — the prober, with global fetch stubbed: Bluesky API
//      semantics, http status→signal mapping, invalid-skip (no probe), and that
//      the concurrency pool returns one result per platform in order.
//   4. generate  — generateHandleCandidates against a canned forced tool call.

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ ANTHROPIC_API_KEY: "test-key" }),
}));

const messagesCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: messagesCreate };
  },
}));

import {
  PLATFORMS,
  PLATFORM_ORDER,
  isValidForPlatform,
  normalizeHandle,
} from "@/lib/handles/platforms";
import { dedupeCandidates, handleCandidatesSchema } from "@/lib/handles/schema";
import { probePlatform, checkHandleAvailability } from "@/lib/handles/availability";
import { generateHandleCandidates } from "@/lib/handles/generate";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("normalizeHandle", () => {
  it("lowercases, strips @, spaces, and disallowed chars", () => {
    expect(normalizeHandle("  @My Brand!! ")).toBe("mybrand");
    expect(normalizeHandle("Acme_Co.99")).toBe("acme_co.99");
    expect(normalizeHandle("@@double")).toBe("double");
  });
});

describe("isValidForPlatform (format gate)", () => {
  it("rejects an X handle over 15 chars or with a dot", () => {
    expect(isValidForPlatform("sixteencharacter", "x")).toBe(false); // 16
    expect(isValidForPlatform("has.dot", "x")).toBe(false);
    expect(isValidForPlatform("good_one", "x")).toBe(true);
  });

  it("allows dots on Instagram but enforces its length", () => {
    expect(isValidForPlatform("a.b_c", "instagram")).toBe(true);
    expect(isValidForPlatform("a".repeat(31), "instagram")).toBe(false);
  });

  it("enforces Facebook's 5-char minimum", () => {
    expect(isValidForPlatform("abcd", "facebook")).toBe(false);
    expect(isValidForPlatform("abcde", "facebook")).toBe(true);
  });

  it("rejects a Bluesky label that starts/ends with a dash", () => {
    expect(isValidForPlatform("-acme", "bluesky")).toBe(false);
    expect(isValidForPlatform("acme-", "bluesky")).toBe(false);
    expect(isValidForPlatform("ac-me", "bluesky")).toBe(true);
  });
});

describe("URL + claim builders", () => {
  it("builds the right profile + claim URLs", () => {
    expect(PLATFORMS.x.profileUrl("acme")).toBe("https://x.com/acme");
    expect(PLATFORMS.tiktok.profileUrl("acme")).toBe("https://www.tiktok.com/@acme");
    expect(PLATFORMS.bluesky.profileUrl("acme")).toBe("https://bsky.app/profile/acme.bsky.social");
    expect(PLATFORMS.x.claimUrl("acme")).toContain("signup");
  });

  it("covers every platform in the registry in PLATFORM_ORDER", () => {
    expect([...PLATFORM_ORDER].sort()).toEqual(Object.keys(PLATFORMS).sort());
  });
});

describe("dedupeCandidates", () => {
  it("collapses handles that normalise to the same base, preserving order", () => {
    const out = dedupeCandidates([
      { handle: "acme", rationale: "a" },
      { handle: "acme", rationale: "dup" },
      { handle: "acmehq", rationale: "b" },
    ]);
    expect(out.map((c) => c.handle)).toEqual(["acme", "acmehq"]);
  });

  it("schema normalises a handle with @ and caps to base form", () => {
    const parsed = handleCandidatesSchema.parse({
      candidates: [{ handle: "@AcmeCo", rationale: "ok" }],
    });
    expect(parsed.candidates[0].handle).toBe("acmeco");
  });
});

// Build a fake Response with a given status.
function res(status: number) {
  return { status, ok: status >= 200 && status < 300, text: () => Promise.resolve("") };
}

describe("probePlatform: Bluesky (authoritative)", () => {
  it("maps a resolved handle (200) to taken", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res(200)));
    const r = await probePlatform("acme", "bluesky");
    expect(r).toEqual({ platform: "bluesky", status: "taken", source: "bluesky" });
  });

  it("maps unresolvable (400) to available", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res(400)));
    const r = await probePlatform("acme", "bluesky");
    expect(r.status).toBe("available");
  });

  it("maps anything else (5xx) to unknown", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res(503)));
    expect((await probePlatform("acme", "bluesky")).status).toBe("unknown");
  });
});

describe("probePlatform: http signal (everyone else)", () => {
  it("404 → available, 200 → taken, 429/3xx → unknown", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res(404)));
    expect((await probePlatform("acme", "x")).status).toBe("available");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res(200)));
    expect((await probePlatform("acme", "x")).status).toBe("taken");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res(429)));
    expect((await probePlatform("acme", "x")).status).toBe("unknown");
  });

  it("a network error / timeout → unknown (never throws)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("aborted")));
    expect((await probePlatform("acme", "instagram")).status).toBe("unknown");
  });
});

describe("probePlatform: invalid format is never probed", () => {
  it("returns invalid + source 'format' without calling fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(200));
    vi.stubGlobal("fetch", fetchMock);
    // 16 chars + dot — invalid for X.
    const r = await probePlatform("way.too.long.handle", "x");
    expect(r).toEqual({ platform: "x", status: "invalid", source: "format" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("checkHandleAvailability: one result per platform, in order", () => {
  it("returns a status for every requested platform", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res(404)));
    const out = await checkHandleAvailability("acme", PLATFORM_ORDER);
    expect(out.map((o) => o.platform)).toEqual(PLATFORM_ORDER);
    expect(out.every((o) => typeof o.status === "string")).toBe(true);
  });
});

describe("generateHandleCandidates (mocked Claude)", () => {
  beforeEach(() => {
    messagesCreate.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          name: "submit_handles",
          input: {
            candidates: [
              { handle: "acmehq", rationale: "Literal + hq suffix." },
              { handle: "ACMEHQ", rationale: "dup after lowercase" },
              { handle: "getacme", rationale: "Action prefix." },
            ],
          },
        },
      ],
      usage: { input_tokens: 50, output_tokens: 80 },
    });
  });

  it("returns normalised, de-duped candidates", async () => {
    const { candidates } = await generateHandleCandidates({ seed: "Acme" }, { count: 4 });
    // "ACMEHQ" collapses into "acmehq".
    expect(candidates.map((c) => c.handle)).toEqual(["acmehq", "getacme"]);
  });

  it("rejects an out-of-range count before calling the model", async () => {
    await expect(generateHandleCandidates({ seed: "x" }, { count: 99 })).rejects.toThrow(/4-12/);
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it("throws if the model doesn't make the forced tool call", async () => {
    messagesCreate.mockResolvedValueOnce({ content: [{ type: "text", text: "nope" }], usage: {} });
    await expect(generateHandleCandidates({ seed: "x" })).rejects.toThrow(/submit_handles/);
  });
});
