import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Unit: user-video-upload server actions (slice A) ─────────────────────────
//
// createUploadTicketAction + registerUploadedVideoAction back the direct
// browser→Supabase upload flow. The bytes never touch the action; these actions
// only (a) authorize the workspace + validate file meta at the boundary, mint a
// signed upload URL, and record an `uploaded_videos` row in 'uploading', then
// (b) flip that row to 'ready' once the browser confirms the bytes landed.
//
// We mock the SERVICE-ROLE Supabase client (storage.createSignedUploadUrl +
// the uploaded_videos table query builders), the workspace helpers, the feature
// flag, and next/cache. Assertions focus on: the flag gate, the mime/size
// boundary, the workspace-mismatch guard, the signed-URL + row-insert happy
// path, and the cross-tenant guard on register.

const {
  userVideoUploadEnabled,
  getAuthedUserOrRedirect,
  getActiveWorkspaceOrRedirect,
  createSignedUploadUrl,
  listSource,
  insertSingle,
  selectMaybeSingle,
  updateSingle,
  updateFailed,
  revalidatePath,
} = vi.hoisted(() => ({
  userVideoUploadEnabled: vi.fn(() => true),
  getAuthedUserOrRedirect: vi.fn(async () => ({ id: "user-1" })),
  getActiveWorkspaceOrRedirect: vi.fn(async () => ({ id: "11111111-1111-1111-1111-111111111111" })),
  createSignedUploadUrl: vi.fn(
    async (): Promise<{
      data: { signedUrl: string; path: string; token: string } | null;
      error: null | { message: string };
    }> => ({
      data: { signedUrl: "https://x/sign", path: "p", token: "tok-abc" },
      error: null,
    }),
  ),
  // storage.from().list() backing sourceObjectExists. Defaults to a match with
  // bytes so register's storage-confirmation gate passes; tests flip it to empty
  // to exercise the "bytes never landed" path.
  listSource: vi.fn(
    async (): Promise<{
      data: { name: string; metadata?: { size?: number } | null }[] | null;
      error: null | { message: string };
    }> => ({
      data: [{ name: "source.mp4", metadata: { size: 1234 } }],
      error: null,
    }),
  ),
  insertSingle: vi.fn(async () => ({ data: { id: "vid-1" }, error: null as null | { message: string } })),
  selectMaybeSingle: vi.fn(async () => ({
    data: null as null | Record<string, unknown>,
    error: null as null | { message: string },
  })),
  updateSingle: vi.fn(async () => ({
    data: { id: "vid-1", status: "ready" },
    error: null as null | { message: string },
  })),
  // update().eq().eq() terminal used by markUploadedVideoFailed (no .select()).
  updateFailed: vi.fn(async () => ({ error: null as null | { message: string } })),
  revalidatePath: vi.fn(),
}));

// A query builder that records inserts and supports the chains the helpers use:
//   insert().select().single()
//   select().eq().eq().maybeSingle()
//   update().eq().eq().select().single()   (markUploadedVideoReady)
//   update().eq().eq()                       (markUploadedVideoFailed — awaited)
//   storage.from().list()                    (sourceObjectExists)
//
// The two update chains diverge after `.eq().eq()`: the ready path appends
// `.select().single()` while the failed path awaits the `.eq().eq()` result
// directly. So `.eq().eq()` returns a thenable that ALSO carries `.select()`.
function makeServiceClient() {
  const updateTerminal = Object.assign(
    // Make the node awaitable for markUploadedVideoFailed (resolves via updateFailed).
    { then: (...args: Parameters<Promise<unknown>["then"]>) => updateFailed().then(...args) },
    // Keep the ready chain working for markUploadedVideoReady.
    { select: () => ({ single: updateSingle }) },
  );
  return {
    storage: {
      from: () => ({ createSignedUploadUrl, list: listSource }),
    },
    from: () => ({
      insert: () => ({ select: () => ({ single: insertSingle }) }),
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: selectMaybeSingle }) }) }),
      update: () => ({ eq: () => ({ eq: () => updateTerminal }) }),
    }),
  };
}

vi.mock("@/lib/env", () => ({ userVideoUploadEnabled }));
vi.mock("@/lib/workspace", () => ({ getAuthedUserOrRedirect, getActiveWorkspaceOrRedirect }));
vi.mock("@/lib/supabase/service", () => ({ supabaseService: () => makeServiceClient() }));
vi.mock("next/cache", () => ({ revalidatePath }));

import {
  createUploadTicketAction,
  registerUploadedVideoAction,
} from "@/app/(app)/video/upload/actions";

const WS = "11111111-1111-1111-1111-111111111111";
const VID = "22222222-2222-2222-2222-222222222222";

beforeEach(() => {
  userVideoUploadEnabled.mockReturnValue(true);
  getActiveWorkspaceOrRedirect.mockResolvedValue({ id: WS });
  createSignedUploadUrl.mockResolvedValue({
    data: { signedUrl: "https://x/sign", path: "p", token: "tok-abc" },
    error: null,
  });
  insertSingle.mockResolvedValue({ data: { id: VID }, error: null });
  selectMaybeSingle.mockResolvedValue({ data: null, error: null });
  updateSingle.mockResolvedValue({ data: { id: VID, status: "ready" }, error: null });
  updateFailed.mockResolvedValue({ error: null });
  // Default: the source object is present with bytes so register's gate passes.
  listSource.mockResolvedValue({
    data: [{ name: "source.mp4", metadata: { size: 1234 } }],
    error: null,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("createUploadTicketAction", () => {
  it("refuses when the feature flag is off (no signed URL minted)", async () => {
    userVideoUploadEnabled.mockReturnValue(false);
    const res = await createUploadTicketAction(WS, "talk.mp4", "video/mp4", 1000);
    expect(res.ok).toBe(false);
    expect(createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("rejects a disallowed mime type at the boundary", async () => {
    const res = await createUploadTicketAction(WS, "evil.exe", "application/octet-stream", 1000);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/MP4, MOV, or WebM/i);
    expect(createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("rejects a file over the 2GB cap", async () => {
    const res = await createUploadTicketAction(WS, "huge.mp4", "video/mp4", 3 * 1024 * 1024 * 1024);
    expect(res.ok).toBe(false);
    expect(createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("rejects a workspaceId that doesn't match the active session", async () => {
    const res = await createUploadTicketAction(
      "99999999-9999-9999-9999-999999999999",
      "talk.mp4",
      "video/mp4",
      1000,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/workspace changed/i);
    expect(createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("mints a signed URL + records an uploading row on the happy path", async () => {
    const res = await createUploadTicketAction(WS, "My Talk.mov", "video/quicktime", 5000);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.ticket.token).toBe("tok-abc");
      expect(res.ticket.path).toMatch(new RegExp(`^${WS}/.+/source\\.mov$`));
      expect(res.ticket.uploadedVideoId).toEqual(expect.any(String));
    }
    expect(createSignedUploadUrl).toHaveBeenCalledTimes(1);
    expect(insertSingle).toHaveBeenCalledTimes(1);
  });

  it("surfaces a storage error and does not claim success", async () => {
    createSignedUploadUrl.mockResolvedValue({ data: null, error: { message: "boom" } });
    const res = await createUploadTicketAction(WS, "talk.mp4", "video/mp4", 1000);
    expect(res.ok).toBe(false);
    expect(insertSingle).not.toHaveBeenCalled();
  });
});

describe("registerUploadedVideoAction", () => {
  it("refuses when the feature flag is off", async () => {
    userVideoUploadEnabled.mockReturnValue(false);
    const res = await registerUploadedVideoAction(VID, { duration: 12 });
    expect(res.ok).toBe(false);
    expect(updateSingle).not.toHaveBeenCalled();
  });

  it("rejects an id that resolves to no row in this workspace (cross-tenant guard)", async () => {
    selectMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await registerUploadedVideoAction(VID, { duration: 12 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/doesn't belong/i);
    expect(updateSingle).not.toHaveBeenCalled();
  });

  it("flips the row to ready with probed metadata on the happy path", async () => {
    selectMaybeSingle.mockResolvedValue({
      data: {
        id: VID,
        workspace_id: WS,
        status: "uploading",
        storage_path: `${WS}/${VID}/source.mp4`,
      },
      error: null,
    });
    const res = await registerUploadedVideoAction(VID, { duration: 12.5, width: 1920, height: 1080 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.uploadedVideoId).toBe(VID);
    expect(updateSingle).toHaveBeenCalledTimes(1);
    expect(revalidatePath).toHaveBeenCalledWith("/video/upload");
  });

  it("fails (and doesn't go ready) when the bytes never landed in storage", async () => {
    selectMaybeSingle.mockResolvedValue({
      data: {
        id: VID,
        workspace_id: WS,
        status: "uploading",
        storage_path: `${WS}/${VID}/source.mp4`,
      },
      error: null,
    });
    // No object in the bucket → sourceObjectExists returns false.
    listSource.mockResolvedValue({ data: [], error: null });
    const res = await registerUploadedVideoAction(VID, { duration: 12 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/couldn't find the uploaded video/i);
    // Never flipped to ready…
    expect(updateSingle).not.toHaveBeenCalled();
    // …and the row was marked failed instead.
    expect(updateFailed).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-uuid id at the boundary", async () => {
    const res = await registerUploadedVideoAction("not-a-uuid", { duration: 1 });
    expect(res.ok).toBe(false);
    expect(selectMaybeSingle).not.toHaveBeenCalled();
  });
});
