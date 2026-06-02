import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Unit: BYO credential encryption (src/lib/video/byo-keys.ts) ──────────────
//
// byo-keys imports two collaborators we mock so there's no real network / real
// schema validation:
//   - `@/lib/env` serverEnv() → we hand back a single field, BYO_ENCRYPTION_KEY.
//   - `@/lib/supabase/service` supabaseService() → an in-memory fake whose
//     upsert captures the ciphertext and whose select replays it. This lets us
//     exercise the FULL set→get roundtrip (encrypt at write, decrypt at read)
//     without a DB, and prove the table never sees plaintext.

// A valid 32-byte key as 64 hex chars (AES-256). Held in a mutable holder so a
// single test can swap in a wrong-length key.
const VALID_HEX_KEY = "0".repeat(64);
const envHolder = { BYO_ENCRYPTION_KEY: VALID_HEX_KEY as string | undefined };

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ BYO_ENCRYPTION_KEY: envHolder.BYO_ENCRYPTION_KEY }),
}));

// In-memory stand-in for the workspace_byo_keys table. Rows keyed by
// (workspace_id, provider); upsert overwrites, select filters by workspace.
interface FakeRow {
  workspace_id: string;
  provider: string;
  ciphertext: string;
  created_by: string | null;
}
const store: FakeRow[] = [];

function fakeSupabase() {
  return {
    from(table: string) {
      if (table !== "workspace_byo_keys") throw new Error(`unexpected table ${table}`);
      return {
        upsert(row: FakeRow) {
          const idx = store.findIndex(
            (r) => r.workspace_id === row.workspace_id && r.provider === row.provider,
          );
          if (idx >= 0) store[idx] = row;
          else store.push(row);
          return Promise.resolve({ error: null });
        },
        // select("provider, ciphertext") or select("provider") → both chain .eq
        select(cols: string) {
          return {
            eq(_col: string, workspaceId: string) {
              const rows = store
                .filter((r) => r.workspace_id === workspaceId)
                .map((r) =>
                  cols.includes("ciphertext")
                    ? { provider: r.provider, ciphertext: r.ciphertext }
                    : { provider: r.provider },
                );
              return Promise.resolve({ data: rows, error: null });
            },
          };
        },
      };
    },
  };
}

vi.mock("@/lib/supabase/service", () => ({
  supabaseService: () => fakeSupabase(),
}));

import {
  ByoKeyConfigError,
  getWorkspaceKeyStatus,
  getWorkspaceKeys,
  setWorkspaceKeys,
  type ByoLlmSecrets,
  type ByoPexelsSecrets,
} from "@/lib/video/byo-keys";

const WS = "ws-1";
const LLM: ByoLlmSecrets = {
  provider: "openai",
  api_key: "sk-secret-llm-key",
  model_name: "gpt-4o-mini",
  base_url: "https://api.openai.com/v1",
};
const PEXELS: ByoPexelsSecrets = { api_keys: ["pexels-key-1", "pexels-key-2"] };

beforeEach(() => {
  store.length = 0;
  envHolder.BYO_ENCRYPTION_KEY = VALID_HEX_KEY;
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("byo-keys: encrypt→decrypt roundtrip via set/getWorkspaceKeys", () => {
  it("roundtrips LLM + Pexels secrets through encrypt-at-write / decrypt-at-read", async () => {
    await setWorkspaceKeys(WS, "llm", LLM);
    await setWorkspaceKeys(WS, "pexels", PEXELS);

    const keys = await getWorkspaceKeys(WS);
    expect(keys.llm).toEqual(LLM);
    expect(keys.pexels).toEqual(PEXELS);
  });

  it("stores only opaque ciphertext at rest — never plaintext", async () => {
    await setWorkspaceKeys(WS, "llm", LLM);
    const row = store.find((r) => r.provider === "llm")!;
    // The encrypted blob is iv:tag:ciphertext (3 base64 segments) and must not
    // contain the plaintext secret anywhere.
    expect(row.ciphertext.split(":")).toHaveLength(3);
    expect(row.ciphertext).not.toContain(LLM.api_key);
    expect(row.ciphertext).not.toContain("openai");
  });

  it("each encryption uses a fresh IV (same plaintext → different ciphertext)", async () => {
    await setWorkspaceKeys(WS, "llm", LLM);
    const firstCt = store.find((r) => r.provider === "llm")!.ciphertext;
    await setWorkspaceKeys(WS, "llm", LLM); // overwrite with identical secrets
    const secondCt = store.find((r) => r.provider === "llm")!.ciphertext;
    expect(secondCt).not.toEqual(firstCt);
    // ...but both still decrypt back to the same plaintext.
    const keys = await getWorkspaceKeys(WS);
    expect(keys.llm).toEqual(LLM);
  });
});

describe("byo-keys: tamper + bad-key safety", () => {
  it("throws when the ciphertext has been tampered with (GCM auth fails)", async () => {
    await setWorkspaceKeys(WS, "llm", LLM);
    const row = store.find((r) => r.provider === "llm")!;
    // Flip the final base64 char of the ciphertext segment. GCM's auth tag
    // verification must reject the modified payload.
    const [iv, tag, ct] = row.ciphertext.split(":");
    const flipped = ct.slice(0, -1) + (ct.slice(-1) === "A" ? "B" : "A");
    row.ciphertext = [iv, tag, flipped].join(":");

    await expect(getWorkspaceKeys(WS)).rejects.toThrow();
  });

  it("throws ByoKeyConfigError on a malformed (non iv:tag:ct) blob", async () => {
    store.push({ workspace_id: WS, provider: "llm", ciphertext: "not-a-valid-blob", created_by: null });
    await expect(getWorkspaceKeys(WS)).rejects.toBeInstanceOf(ByoKeyConfigError);
  });

  it("throws ByoKeyConfigError when BYO_ENCRYPTION_KEY decodes to the wrong length", async () => {
    envHolder.BYO_ENCRYPTION_KEY = "tooshort"; // not 32 bytes hex or base64
    await expect(setWorkspaceKeys(WS, "llm", LLM)).rejects.toBeInstanceOf(ByoKeyConfigError);
  });

  it("throws ByoKeyConfigError when BYO_ENCRYPTION_KEY is unset", async () => {
    envHolder.BYO_ENCRYPTION_KEY = undefined;
    await expect(setWorkspaceKeys(WS, "llm", LLM)).rejects.toBeInstanceOf(ByoKeyConfigError);
  });
});

describe("byo-keys: getWorkspaceKeyStatus never leaks plaintext", () => {
  it("returns presence booleans only, with no decryption", async () => {
    await setWorkspaceKeys(WS, "llm", LLM);
    const status = await getWorkspaceKeyStatus(WS);
    expect(status).toEqual({
      llm: true,
      pexels: false,
      fal_video: false,
      did_video: false,
      heygen_video: false,
    });
    // Serialise the whole result and assert the secret can't appear in it.
    expect(JSON.stringify(status)).not.toContain(LLM.api_key);
  });

  it("reports both providers once present", async () => {
    await setWorkspaceKeys(WS, "llm", LLM);
    await setWorkspaceKeys(WS, "pexels", PEXELS);
    expect(await getWorkspaceKeyStatus(WS)).toEqual({
      llm: true,
      pexels: true,
      fal_video: false,
      did_video: false,
      heygen_video: false,
    });
  });

  it("works even when the encryption key is absent (status reads no ciphertext)", async () => {
    // Seed a row directly, then drop the key. Status must still answer without
    // throwing because it never decrypts.
    store.push({ workspace_id: WS, provider: "llm", ciphertext: "iv:tag:ct", created_by: null });
    envHolder.BYO_ENCRYPTION_KEY = undefined;
    expect(await getWorkspaceKeyStatus(WS)).toEqual({
      llm: true,
      pexels: false,
      fal_video: false,
      did_video: false,
      heygen_video: false,
    });
  });
});
