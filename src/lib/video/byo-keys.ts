// Bring-your-own (BYO) credential storage for the video pipeline.
//
// Customers supply their OWN LLM + Pexels keys. We never want these in
// plaintext at rest, and clients must never read them back. This module:
//
//   - Encrypts a secrets bundle with AES-256-GCM (BYO_ENCRYPTION_KEY) before
//     it touches the DB, storing iv + auth tag + ciphertext together.
//   - Decrypts ONLY on the server (service-role) at dispatch time, when the
//     orchestrator hands the keys straight to MPT.
//
// The DB (workspace_byo_keys) only ever sees the opaque base64 blob, and the
// table is RLS-locked to service-role (no public policies). NEVER return
// plaintext to a client — getWorkspaceKeys is a service-role-only helper.

import crypto from "node:crypto";
import { serverEnv } from "@/lib/env";
import { supabaseService } from "@/lib/supabase/service";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12; // GCM standard nonce length.
const KEY_BYTES = 32; // AES-256.

// The per-provider plaintext shape. `llm` holds the LLM provider creds;
// `pexels` holds one or more Pexels API keys. Stored as a flat record so we
// can evolve fields without a migration — the whole bundle is one blob.
export interface ByoLlmSecrets {
  provider: string; // e.g. "openai", "deepseek", "moonshot"
  api_key: string;
  base_url?: string;
  model_name: string;
}
export interface ByoPexelsSecrets {
  api_keys: string[];
}
// SPIKE — Reference-image video (bet ④). The workspace's own image-to-video
// provider key (recommended: a fal.ai key — see the spike doc). Defined here so
// it rides the SAME AES-256-GCM machinery as the other BYO secrets, but NOT yet
// added to the live getWorkspaceKeys decode switch (the shipped MPT path must
// stay untouched until a vendor is wired). Gated by REFERENCE_VIDEO_ENABLED.
export interface ByoFalVideoSecrets {
  api_key: string;
}
// Reference-image video (bet ④ · Capability B "Make it talk"). The workspace's
// own D-ID API key for the talking-avatar path. Same AES-256-GCM machinery as the
// other BYO secrets; stored as its OWN provider row ('did_video') so it sits
// alongside — never replaces — the fal_video key (a workspace can have both).
export interface ByoDidVideoSecrets {
  api_key: string;
}
// Reference-image video (bet ④ · Capability B "Make it talk"). The workspace's
// own HeyGen API key for the talking-avatar path — the SECOND 'present' provider,
// alongside D-ID. Same AES-256-GCM machinery as the other BYO secrets; stored as
// its OWN provider row ('heygen_video') so a workspace can have D-ID, HeyGen, both,
// or neither.
export interface ByoHeygenVideoSecrets {
  api_key: string;
}
export type ByoProvider = "llm" | "pexels" | "fal_video" | "did_video" | "heygen_video";
export type ByoSecrets =
  | ByoLlmSecrets
  | ByoPexelsSecrets
  | ByoFalVideoSecrets
  | ByoDidVideoSecrets
  | ByoHeygenVideoSecrets;

// Thrown when BYO_ENCRYPTION_KEY is missing/wrong-length. Distinct type so
// callers can surface "video keys not configured" vs a generic crypto error.
export class ByoKeyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ByoKeyConfigError";
  }
}

// Decode BYO_ENCRYPTION_KEY into exactly 32 bytes. Accepts 64-char hex or
// base64 (44 chars padded). Throws ByoKeyConfigError on absence/bad length so
// we never silently encrypt with a truncated key.
function encryptionKey(): Buffer {
  const env = serverEnv();
  const raw = env.BYO_ENCRYPTION_KEY;
  if (!raw) {
    throw new ByoKeyConfigError("BYO_ENCRYPTION_KEY is not set; video BYO keys are unavailable.");
  }
  let key: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, "hex");
  } else {
    const decoded = Buffer.from(raw, "base64");
    if (decoded.length === KEY_BYTES) key = decoded;
  }
  if (!key || key.length !== KEY_BYTES) {
    throw new ByoKeyConfigError(
      "BYO_ENCRYPTION_KEY must decode to 32 bytes (64 hex chars or base64).",
    );
  }
  return key;
}

// Serialise as iv:tag:ciphertext, each base64, joined by ":". Self-describing
// and easy to split on read; no ambiguity since base64 has no ":".
function encrypt(plaintext: string): string {
  const key = encryptionKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

function decrypt(blob: string): string {
  const key = encryptionKey();
  const parts = blob.split(":");
  if (parts.length !== 3) {
    throw new ByoKeyConfigError("Malformed BYO ciphertext (expected iv:tag:ciphertext).");
  }
  const [ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

// Encrypt + upsert a provider's secrets for a workspace. Service-role only.
// Overwrites any existing row for (workspace, provider).
export async function setWorkspaceKeys(
  workspaceId: string,
  provider: ByoProvider,
  secrets: ByoSecrets,
  createdBy?: string | null,
): Promise<void> {
  const ciphertext = encrypt(JSON.stringify(secrets));
  const svc = supabaseService();
  const { error } = await svc
    .from("workspace_byo_keys")
    .upsert(
      {
        workspace_id: workspaceId,
        provider,
        ciphertext,
        created_by: createdBy ?? null,
      },
      { onConflict: "workspace_id,provider" },
    );
  if (error) {
    throw new Error(`setWorkspaceKeys failed: ${error.message}`);
  }
}

// Decrypted view of all BYO secrets for a workspace. SERVICE-ROLE ONLY — this
// returns plaintext and must NEVER be exposed to a client. Missing providers
// are simply absent from the result.
export interface WorkspaceKeys {
  llm?: ByoLlmSecrets;
  pexels?: ByoPexelsSecrets;
  // Reference-image video (bet ④) — the workspace's own fal.ai image-to-video
  // key. Absent for workspaces that haven't opted into the reference-video path.
  fal_video?: ByoFalVideoSecrets;
  // Reference-image video (bet ④ · Capability B) — the workspace's own D-ID
  // talking-avatar key. Independent of fal_video; a workspace can have either,
  // both, or neither.
  did_video?: ByoDidVideoSecrets;
  // Reference-image video (bet ④ · Capability B) — the workspace's own HeyGen
  // talking-avatar key (the second 'present' provider). Independent of the others;
  // a workspace can have D-ID, HeyGen, both, or neither.
  heygen_video?: ByoHeygenVideoSecrets;
}

export async function getWorkspaceKeys(workspaceId: string): Promise<WorkspaceKeys> {
  const svc = supabaseService();
  const { data, error } = await svc
    .from("workspace_byo_keys")
    .select("provider, ciphertext")
    .eq("workspace_id", workspaceId);
  if (error) {
    throw new Error(`getWorkspaceKeys failed: ${error.message}`);
  }
  const out: WorkspaceKeys = {};
  for (const row of data ?? []) {
    const parsed = JSON.parse(decrypt(row.ciphertext)) as ByoSecrets;
    if (row.provider === "llm") out.llm = parsed as ByoLlmSecrets;
    else if (row.provider === "pexels") out.pexels = parsed as ByoPexelsSecrets;
    else if (row.provider === "fal_video") out.fal_video = parsed as ByoFalVideoSecrets;
    else if (row.provider === "did_video") out.did_video = parsed as ByoDidVideoSecrets;
    else if (row.provider === "heygen_video") out.heygen_video = parsed as ByoHeygenVideoSecrets;
  }
  return out;
}

// Presence-only status for the settings UI. Selects ONLY the `provider`
// column (never the ciphertext) so plaintext can't leak — it returns a pair
// of booleans answering "is a key on file?" without decrypting anything.
// Safe for a server action to call and pass to the client, unlike
// getWorkspaceKeys which returns plaintext and is service-role-only.
export interface WorkspaceKeyStatus {
  llm: boolean;
  pexels: boolean;
  // Reference-image video (bet ④) fal key presence. Drives the settings UI's
  // Configured/Not pill for the reference-video key — never a value.
  fal_video: boolean;
  // Reference-image video (bet ④ · Capability B) D-ID key presence. Drives the
  // talking-avatar key form's Configured/Not pill — never a value.
  did_video: boolean;
  // Reference-image video (bet ④ · Capability B) HeyGen key presence. Drives the
  // second talking-avatar key form's Configured/Not pill — never a value.
  heygen_video: boolean;
}

export async function getWorkspaceKeyStatus(workspaceId: string): Promise<WorkspaceKeyStatus> {
  const svc = supabaseService();
  const { data, error } = await svc
    .from("workspace_byo_keys")
    .select("provider")
    .eq("workspace_id", workspaceId);
  if (error) {
    throw new Error(`getWorkspaceKeyStatus failed: ${error.message}`);
  }
  const providers = new Set((data ?? []).map((r) => r.provider));
  return {
    llm: providers.has("llm"),
    pexels: providers.has("pexels"),
    fal_video: providers.has("fal_video"),
    did_video: providers.has("did_video"),
    heygen_video: providers.has("heygen_video"),
  };
}

// Delete a provider's stored credentials for a workspace. Service-role only;
// powers the "Remove" affordance in the settings UI. No-op if absent.
export async function removeWorkspaceKeys(
  workspaceId: string,
  provider: ByoProvider,
): Promise<void> {
  const svc = supabaseService();
  const { error } = await svc
    .from("workspace_byo_keys")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("provider", provider);
  if (error) {
    throw new Error(`removeWorkspaceKeys failed: ${error.message}`);
  }
}
