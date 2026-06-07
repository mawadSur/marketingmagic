import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Unit: audio_retention_opt_in toggle (Phase 2.6) ───────────────────────
//
// Backs the /settings/brief "Voice-memo audio retention" control. Two pieces:
//   1. parseOptInCheckbox — pure coercion of the HTML checkbox field. Checked
//      submits value "on" (or "true"/"1"); unchecked omits the field (null).
//   2. updateAudioRetentionAction — opt-in true / opt-out false both persist
//      to brand_briefs; a missing brief row is a hard guard (we never auto-
//      create one — audio retention without a brief is meaningless).
//
// We mock the Supabase server client so we can drive the brief-existence probe
// and assert exactly what (if anything) gets written, plus the workspace +
// next/cache shims the action calls.

const { selectMaybeSingle, update, updateEq, revalidatePath } = vi.hoisted(() => {
  const updateEq = vi.fn(async () => ({ error: null as null | { message: string } }));
  return {
    selectMaybeSingle: vi.fn(async () => ({ data: null as null | { workspace_id: string } })),
    update: vi.fn(() => ({ eq: updateEq })),
    updateEq,
    revalidatePath: vi.fn(),
  };
});

function makeServerClient() {
  return {
    from: (_table: string) => ({
      select: () => ({ eq: () => ({ maybeSingle: selectMaybeSingle }) }),
      update,
    }),
  };
}

vi.mock("@/lib/supabase/server", () => ({ supabaseServer: async () => makeServerClient() }));
vi.mock("@/lib/workspace", () => ({
  getActiveWorkspaceOrRedirect: async () => ({ id: "ws-1" }),
}));
vi.mock("next/cache", () => ({ revalidatePath }));

import {
  parseOptInCheckbox,
  updateAudioRetentionAction,
  type AudioRetentionState,
} from "@/app/(app)/settings/brief/audio-retention-actions";

const prev: AudioRetentionState = { error: null, message: null };

function form(optIn: string | null): FormData {
  const fd = new FormData();
  if (optIn !== null) fd.set("opt_in", optIn);
  return fd;
}

beforeEach(() => {
  selectMaybeSingle.mockResolvedValue({ data: { workspace_id: "ws-1" } });
  updateEq.mockResolvedValue({ error: null });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("parseOptInCheckbox", () => {
  it("treats a checked box (value 'on'/'true'/'1') as opt-in", () => {
    expect(parseOptInCheckbox("on")).toBe(true);
    expect(parseOptInCheckbox("true")).toBe(true);
    expect(parseOptInCheckbox("1")).toBe(true);
  });

  it("treats an absent or falsey field as opt-out", () => {
    expect(parseOptInCheckbox(null)).toBe(false);
    expect(parseOptInCheckbox("off")).toBe(false);
    expect(parseOptInCheckbox("")).toBe(false);
    expect(parseOptInCheckbox("false")).toBe(false);
  });
});

describe("updateAudioRetentionAction — opt-in true", () => {
  it("writes audio_retention_opt_in:true and confirms the 30-day message", async () => {
    const res = await updateAudioRetentionAction(prev, form("on"));
    expect(res.error).toBeNull();
    expect(res.message).toMatch(/kept for 30 days/i);
    expect(update).toHaveBeenCalledWith({ audio_retention_opt_in: true });
    expect(updateEq).toHaveBeenCalledWith("workspace_id", "ws-1");
    expect(revalidatePath).toHaveBeenCalledWith("/settings/brief");
    expect(revalidatePath).toHaveBeenCalledWith("/record");
  });
});

describe("updateAudioRetentionAction — opt-out false", () => {
  it("writes audio_retention_opt_in:false and confirms the delete message", async () => {
    const res = await updateAudioRetentionAction(prev, form(null));
    expect(res.error).toBeNull();
    expect(res.message).toMatch(/deleted right after transcription/i);
    expect(update).toHaveBeenCalledWith({ audio_retention_opt_in: false });
  });
});

describe("updateAudioRetentionAction — missing-brief guard", () => {
  it("refuses to write (no update) when no brief row exists", async () => {
    selectMaybeSingle.mockResolvedValueOnce({ data: null });
    const res = await updateAudioRetentionAction(prev, form("on"));
    expect(res.error).toMatch(/brand brief/i);
    expect(res.message).toBeNull();
    expect(update).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("updateAudioRetentionAction — surfaces DB errors", () => {
  it("returns the update error message and does not revalidate", async () => {
    updateEq.mockResolvedValueOnce({ error: { message: "boom" } });
    const res = await updateAudioRetentionAction(prev, form("on"));
    expect(res.error).toBe("boom");
    expect(res.message).toBeNull();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
