// Discord interaction signature verification.
//
// Discord signs every webhook to the Interactions Endpoint with an Ed25519
// signature over `X-Signature-Timestamp + raw-body`, validated against the
// app's Public Key. If verification fails we MUST respond 401; Discord
// uses unsigned probes during endpoint registration to test the URL and
// expects 401 on failure.
//
// We use Node's built-in `crypto.verify` with the Ed25519 curve — Node 16+
// supports this natively, no `tweetnacl` dependency required. The native
// path is also faster (libsodium-backed) than the JS pure tweetnacl impl.

import crypto from "node:crypto";

// Discord public keys are 64-char hex. We wrap the raw key in an SPKI DER
// envelope so `createPublicKey` can ingest it without us shelling out to
// PEM/JWK conversion. The constant prefix below is the standard ASN.1 SPKI
// header for an X25519/Ed25519 key (RFC 8410). Building it once and reusing
// avoids per-request allocation.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function rawHexToKeyObject(hex: string): crypto.KeyObject {
  const raw = Buffer.from(hex, "hex");
  if (raw.length !== 32) {
    throw new Error(`Ed25519 public key must be 32 bytes (got ${raw.length})`);
  }
  const spki = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
  return crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
}

let cachedKeyHex: string | null = null;
let cachedKey: crypto.KeyObject | null = null;

function getKey(publicKeyHex: string): crypto.KeyObject {
  if (cachedKey && cachedKeyHex === publicKeyHex) return cachedKey;
  cachedKey = rawHexToKeyObject(publicKeyHex);
  cachedKeyHex = publicKeyHex;
  return cachedKey;
}

export interface VerifyArgs {
  publicKeyHex: string;
  signatureHex: string;
  timestamp: string;
  body: string;
}

/**
 * Returns true iff the Ed25519 signature over `${timestamp}${body}` is valid
 * for the supplied public key. All inputs are caller-trusted to be strings;
 * malformed hex returns false rather than throwing so the route handler can
 * 401 cleanly on every failure mode without leaking error shape.
 */
export function verifyDiscordSignature(args: VerifyArgs): boolean {
  const { publicKeyHex, signatureHex, timestamp, body } = args;
  if (!publicKeyHex || !signatureHex || !timestamp) return false;
  // Signatures are 64 bytes → 128 hex chars. Anything else is malformed.
  if (signatureHex.length !== 128 || !/^[0-9a-fA-F]+$/.test(signatureHex)) {
    return false;
  }
  let key: crypto.KeyObject;
  try {
    key = getKey(publicKeyHex);
  } catch {
    return false;
  }
  const sig = Buffer.from(signatureHex, "hex");
  const msg = Buffer.from(timestamp + body, "utf8");
  try {
    // Algorithm arg is `null` for Ed25519 — the curve is fully described
    // by the key object's asymmetricKeyType. Passing a string would throw.
    return crypto.verify(null, msg, key, sig);
  } catch {
    return false;
  }
}
