import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ── Unit: auto-publish fail-safe wiring (static source) ───────────────────────
//
// dedupePosts(ws, candidates, { failSafe: true }) is the fail-SAFE switch: on a
// corpus READ FAILURE it returns every candidate as "near" so the caller routes
// it to pending_approval instead of letting a possible duplicate auto-publish.
//
// SEVEN code paths can write status 'scheduled' (auto-publish on a trusted
// channel) and ALL must gate fail-SAFE so a transient DB blip never lets a
// duplicate slip out unreviewed:
//   - Inline dedupePosts({ failSafe: true }): plans/new, goals/[id], the inbound
//     webhook rule engine, and the Public REST API createPost (each has bespoke
//     per-row trust logic).
//   - Via the shared gateBatchForDedup() choke-point (which is failSafe by
//     construction): the batch generators sources/[id], sources/build-in-public,
//     and voice-memo/persist.
//
// The two human-gated insert-paths (dashboard regen + sources atomize) are always
// pending_approval, so they keep the legacy fail-OPEN contract (a read blip never
// blocks content creation). This test pins the asymmetry at the source so a future
// edit that drops fail-safe from an auto-publish path — or adds it to a
// human-gated path by mistake — fails CI instead of silently changing the
// guarantee.

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// Match a dedupePosts(...) call and capture its full argument list, including a
// trailing options object across newlines (the call sites span several lines).
const DEDUP_CALL = /dedupePosts\(([\s\S]*?)\)\s*;/g;

function dedupCalls(src: string): string[] {
  return [...src.matchAll(DEDUP_CALL)].map((m) => m[0]);
}

describe("auto-publish dedup fail-safe wiring", () => {
  it("plans/new passes { failSafe: true } at EVERY dedupePosts call site", () => {
    const src = read("../../src/app/(app)/plans/new/actions.ts");
    const calls = dedupCalls(src);
    // The initial gate AND the post-regeneration re-check both drive what gets
    // inserted, so both must be fail-safe.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect(call).toMatch(/failSafe:\s*true/);
    }
  });

  it("goals/[id] passes { failSafe: true } at its dedupePosts call site", () => {
    const src = read("../../src/app/(app)/goals/[id]/actions.ts");
    const calls = dedupCalls(src);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const call of calls) {
      expect(call).toMatch(/failSafe:\s*true/);
    }
  });

  it("webhook rule engine passes { failSafe: true } at its dedupePosts call site", () => {
    const src = read("../../src/app/api/webhooks/[workspace_id]/route.ts");
    const calls = dedupCalls(src);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const call of calls) {
      expect(call).toMatch(/failSafe:\s*true/);
    }
  });

  it("Public API createPost passes { failSafe: true } at its dedupePosts call site", () => {
    const src = read("../../src/lib/api/context.ts");
    const calls = dedupCalls(src);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const call of calls) {
      expect(call).toMatch(/failSafe:\s*true/);
    }
  });

  it("the shared gateBatchForDedup() helper passes { failSafe: true } to dedupePosts", () => {
    const src = read("../../src/lib/dedup/gate.ts");
    // Find the dedupePosts call INSIDE gateBatchForDedup and assert it's failSafe.
    const helper = src.slice(src.indexOf("export async function gateBatchForDedup"));
    const calls = dedupCalls(helper);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const call of calls) {
      expect(call).toMatch(/failSafe:\s*true/);
    }
  });

  it("batch generators route through gateBatchForDedup before insert", () => {
    // These auto-publish on a trusted channel, so they must gate the whole batch
    // through the fail-safe helper rather than inserting raw.
    for (const rel of [
      "../../src/app/(app)/sources/[id]/actions.ts",
      "../../src/app/(app)/sources/build-in-public/actions.ts",
      "../../src/lib/voice-memo/persist.ts",
    ]) {
      const src = read(rel);
      expect(src).toMatch(/gateBatchForDedup\(/);
      // And they must insert the GATED payload, never the raw pre-gate array.
      expect(src).toMatch(/\.insert\(gated/);
    }
  });

  it("human-gated paths (dashboard regen, sources atomize) stay fail-OPEN", () => {
    // These never write 'scheduled' (always pending_approval), so a corpus read
    // blip should NOT block content creation — they must NOT opt into failSafe.
    for (const rel of [
      "../../src/app/(app)/dashboard/actions.ts",
      "../../src/app/(app)/sources/[id]/atomize-actions.ts",
    ]) {
      const calls = dedupCalls(read(rel));
      expect(calls.length).toBeGreaterThanOrEqual(1);
      for (const call of calls) {
        expect(call).not.toMatch(/failSafe/);
      }
    }
  });
});
