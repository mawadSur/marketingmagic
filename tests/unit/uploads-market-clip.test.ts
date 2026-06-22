import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelId } from "@/lib/channels/registry";

// ── Unit: marketClip — fan a finished clip out into queued posts (slice F) ────
//
// marketClip(workspaceId, jobId, {channels, captionContext}) loads a READY
// user_clip video_jobs row + the source transcript, asks the AI layer for one
// caption per eligible channel, builds {kind:"video"} post candidates, runs them
// through the dedup gate, and inserts them as pending_approval so they show up in
// /queue with the clip attached. The behaviours that matter and are pinned here:
//
//   • only VIDEO_PUBLISH_CHANNELS ∩ connected channels are marketed; the rest are
//     surfaced as skippedNotVideoCapable / skippedNotConnected,
//   • every inserted post is status pending_approval with the clip's storage_path
//     as a SOLE video media item (never auto-scheduled),
//   • the batch goes through gateBatchForDedup (so a dup can't slip through),
//   • a not-ready / missing clip is rejected up front (no AI call, no insert),
//   • transcript text is passed to the caption generator as context.
//
// AI is injected via the options seam; the dedup gate is mocked; the supabase
// service is a small stateful fake so the read/insert wiring is exercised for
// real.

// ── Mocks ─────────────────────────────────────────────────────────────────────

// gateBatchForDedup is the choke-point. Default passthrough stamps content_hash +
// auto_scheduled like the real gate, leaving status untouched (our rows are
// already pending_approval).
const { gate } = vi.hoisted(() => ({
  gate: vi.fn(async (_ws: string, posts: Array<Record<string, unknown>>) =>
    posts.map((p) => ({
      ...p,
      content_hash: "hash-" + String(p.text).length,
      low_confidence: false,
      generation_metadata: {
        ...((p.generation_metadata as Record<string, unknown>) ?? {}),
        auto_scheduled: false,
      },
    })),
  ),
}));
vi.mock("@/lib/dedup/gate", () => ({ gateBatchForDedup: gate }));

// VIDEO_PUBLISH_CHANNELS allowlist: bluesky + facebook are video-capable here; x
// is connected but NOT allowlisted (so it must be reported notVideoCapable).
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  const allow = new Set(["bluesky", "facebook"]);
  return {
    ...actual,
    videoPublishEnabled: (ch: string) => allow.has(ch.toLowerCase()),
  };
});

// ── Stateful supabase fake ────────────────────────────────────────────────────

type Row = Record<string, unknown>;
function makeFake(seed: Record<string, Row[]>) {
  const db: Record<string, Row[]> = JSON.parse(JSON.stringify(seed));
  function matches(r: Row, filters: Array<[string, unknown]>) {
    return filters.every(([col, val]) => r[col] === val);
  }
  return {
    _db: db,
    from(table: string) {
      db[table] ??= [];
      const filters: Array<[string, unknown]> = [];
      const q: Record<string, unknown> = {
        eq(col: string, val: unknown) {
          filters.push([col, val]);
          return q;
        },
        select() {
          return q;
        },
        async maybeSingle() {
          const hit = db[table]!.find((r) => matches(r, filters));
          return { data: hit ?? null, error: null };
        },
        then(onF: (v: { data: Row[]; error: null }) => unknown) {
          const out = db[table]!.filter((r) => matches(r, filters));
          return Promise.resolve({ data: out, error: null }).then(onF);
        },
        insert(rows: Row[]) {
          const arr = Array.isArray(rows) ? rows : [rows];
          for (const r of arr) db[table]!.push({ id: `${table}-${db[table]!.length + 1}`, ...r });
          return Promise.resolve({ error: null });
        },
      };
      return q;
    },
  };
}

let fake: ReturnType<typeof makeFake>;
vi.mock("@/lib/supabase/service", () => ({ supabaseService: () => fake }));

// ── Subject under test ────────────────────────────────────────────────────────
import { marketClip } from "@/lib/video/uploads/market-clip";

// Deterministic caption generator injected via the options seam (no AI).
const captionGen = vi.fn(async (channels: ChannelId[]) => {
  const m = new Map<ChannelId, string>();
  for (const c of channels) m.set(c, `Caption for ${c}: watch this clip.`);
  return m;
});

function seedDb(overrides?: { jobStatus?: string }) {
  return makeFake({
    video_jobs: [
      {
        id: "job-1",
        workspace_id: "ws-1",
        status: overrides?.jobStatus ?? "ready",
        storage_path: "ws-1/job-1/clip.mp4",
        params: { kind: "user_clip", uploadedVideoId: "uv-1", label: "clip", startMs: 0, endMs: 5000, burnCaptions: false },
      },
    ],
    social_accounts: [
      { id: "acct-bsky", workspace_id: "ws-1", channel: "bluesky", status: "connected" },
      { id: "acct-fb", workspace_id: "ws-1", channel: "facebook", status: "connected" },
      { id: "acct-x", workspace_id: "ws-1", channel: "x", status: "connected" },
    ],
    video_transcripts: [
      { id: "vt-1", workspace_id: "ws-1", uploaded_video_id: "uv-1", text: "Here is the surprising result we found.", segments: [] },
    ],
    posts: [],
  });
}

beforeEach(() => {
  fake = seedDb();
  gate.mockClear();
  captionGen.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("marketClip", () => {
  it("markets only video-capable connected channels and reports the rest", async () => {
    const res = await marketClip("ws-1", "job-1", {
      channels: ["bluesky", "facebook", "x"],
      generateCaptions: captionGen,
    });

    expect(res.ok).toBe(true);
    expect(res.created).toBe(2);
    expect(res.marketed.sort()).toEqual(["bluesky", "facebook"]);
    // x is connected but not in VIDEO_PUBLISH_CHANNELS → flagged, not posted.
    expect(res.skippedNotVideoCapable).toEqual(["x"]);
    expect(res.skippedNotConnected).toEqual([]);
  });

  it("inserts pending_approval posts with the clip as the SOLE video media item", async () => {
    await marketClip("ws-1", "job-1", { channels: ["bluesky"], generateCaptions: captionGen });

    const inserted = fake._db.posts!;
    expect(inserted).toHaveLength(1);
    const post = inserted[0]!;
    expect(post.status).toBe("pending_approval");
    expect(post.channel).toBe("bluesky");
    expect(post.social_account_id).toBe("acct-bsky");
    const media = post.media as Array<Record<string, unknown>>;
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({
      kind: "video",
      storage_path: "ws-1/job-1/clip.mp4",
      content_type: "video/mp4",
    });
    // gate stamped a content_hash → it went through the dedup choke-point.
    expect(post.content_hash).toBeTruthy();
    expect((post.generation_metadata as Record<string, unknown>).origin).toBe("clip_marketing");
  });

  it("runs the batch through the dedup gate", async () => {
    await marketClip("ws-1", "job-1", {
      channels: ["bluesky", "facebook"],
      generateCaptions: captionGen,
    });
    expect(gate).toHaveBeenCalledTimes(1);
    expect(gate).toHaveBeenCalledWith(
      "ws-1",
      expect.arrayContaining([expect.objectContaining({ status: "pending_approval" })]),
    );
  });

  it("passes the source transcript to the caption generator as context", async () => {
    await marketClip("ws-1", "job-1", {
      channels: ["bluesky"],
      captionContext: "lead with the result",
      generateCaptions: captionGen,
    });
    expect(captionGen).toHaveBeenCalledWith(
      ["bluesky"],
      "Here is the surprising result we found.",
      "lead with the result",
    );
  });

  it("rejects a clip that hasn't finished rendering (no insert, no AI)", async () => {
    fake = seedDb({ jobStatus: "processing" });
    const res = await marketClip("ws-1", "job-1", { channels: ["bluesky"], generateCaptions: captionGen });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/finished rendering/i);
    expect(captionGen).not.toHaveBeenCalled();
    expect(fake._db.posts).toHaveLength(0);
  });

  it("rejects a clip that doesn't belong to the workspace", async () => {
    const res = await marketClip("ws-OTHER", "job-1", { channels: ["bluesky"], generateCaptions: captionGen });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found/i);
  });

  it("fails clearly when no selected channel is video-capable", async () => {
    const res = await marketClip("ws-1", "job-1", { channels: ["x"], generateCaptions: captionGen });
    expect(res.ok).toBe(false);
    expect(res.created).toBe(0);
    expect(res.skippedNotVideoCapable).toEqual(["x"]);
    expect(captionGen).not.toHaveBeenCalled();
    expect(fake._db.posts).toHaveLength(0);
  });
});
