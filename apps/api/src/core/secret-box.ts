import crypto from "node:crypto";
import { env } from "../config/env.js";

/**
 * Generic "encrypt an operator-supplied secret at rest" primitive. Lives in
 * core/ (not email/) so future features — OAuth client secrets, webhook
 * signing keys — can reuse it without depending on the email module.
 *
 * Algorithm: AES-256-GCM (authenticated encryption).
 *
 * Key derivation: HKDF-SHA256 from APP_SECRET, NOT APP_SECRET raw. Reasons:
 *   1. Key separation from session/CSRF material already backed by
 *      APP_SECRET.
 *   2. APP_SECRET is validated `.min(32)` CHARACTERS, not bytes, so HKDF is
 *      needed to normalize to exactly 32 bytes for AES-256 regardless of
 *      the actual input length/encoding.
 *   3. A versioned `info` string gives a clean future rotation/algorithm-
 *      change path.
 *
 * IMPORTANT — operational trade-off: rotating APP_SECRET renders every
 * stored ciphertext produced by this module (e.g. PlatformEmailConfig's
 * passwordCiphertext) permanently undecryptable. The system degrades
 * gracefully in that case (see email.service.ts#resolveTransport, which
 * falls back to the dev console transport and logs a loud error), and the
 * admin must re-enter the secret. This is an accepted trade-off vs.
 * introducing a second required deployment secret solely for this purpose.
 */

const HKDF_SALT = "projecthub-hkdf-salt-v1";
const HKDF_INFO = "projecthub:platform-email-config:v1";
const ENVELOPE_VERSION = "v1";

const IV_LENGTH_BYTES = 12; // GCM standard nonce size
const AUTH_TAG_LENGTH_BYTES = 16;

let cachedKey: Buffer | null = null;

/** Deterministic given an immutable env.APP_SECRET — memoized at module scope. */
function deriveKey(): Buffer {
  if (!cachedKey) {
    cachedKey = Buffer.from(
      crypto.hkdfSync(
        "sha256",
        Buffer.from(env.APP_SECRET, "utf8"),
        Buffer.from(HKDF_SALT),
        Buffer.from(HKDF_INFO),
        32,
      ),
    );
  }
  return cachedKey;
}

function toBase64Url(buf: Buffer): string {
  return buf.toString("base64url");
}

function fromBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

/**
 * Encrypts an operator-supplied secret for storage at rest. Returns a
 * self-describing envelope: "v1:<b64url iv>:<b64url tag>:<b64url ct>". The
 * version string is bound in as AAD so an envelope can never be replayed
 * under a different format version.
 */
export function encryptSecret(plaintext: string): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(ENVELOPE_VERSION));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [ENVELOPE_VERSION, toBase64Url(iv), toBase64Url(authTag), toBase64Url(ciphertext)].join(":");
}

/**
 * Inverse of encryptSecret. Throws on: unknown version prefix, malformed
 * envelope, or GCM auth-tag failure (tampering, or — the realistic case —
 * APP_SECRET having been rotated since the value was written). Callers MUST
 * catch this: see resolveTransport's degradation path in email.service.ts.
 */
export function decryptSecret(envelope: string): string {
  const parts = envelope.split(":");
  if (parts.length !== 4) {
    throw new Error("Malformed secret envelope: expected 4 colon-separated parts.");
  }
  const [version, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
  if (version !== ENVELOPE_VERSION) {
    throw new Error(`Unknown secret envelope version: ${version}`);
  }

  const key = deriveKey();
  const iv = fromBase64Url(ivB64);
  const authTag = fromBase64Url(tagB64);
  const ciphertext = fromBase64Url(ctB64);
  if (authTag.length !== AUTH_TAG_LENGTH_BYTES) {
    throw new Error("Malformed secret envelope: invalid auth tag length.");
  }

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(ENVELOPE_VERSION));
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}
