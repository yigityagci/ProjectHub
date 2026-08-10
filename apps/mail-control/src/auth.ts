import crypto from "node:crypto";

/**
 * Bearer-token auth against `MAIL_CONTROL_TOKEN`. Comparison is
 * digest-then-`timingSafeEqual`: hashing both sides to a fixed-length
 * SHA-256 digest before comparing makes the comparison BOTH constant-time
 * (timingSafeEqual) AND length-independent (timingSafeEqual throws on a
 * length mismatch between its two buffers — comparing raw,
 * caller-controlled-length tokens directly would leak the real token's
 * length via that throw/no-throw difference, and comparing digests avoids
 * that entirely since SHA-256 output is always 32 bytes).
 */
export function digest(value: string): Buffer {
  return crypto.createHash("sha256").update(value, "utf8").digest();
}

export function isAuthorized(authorizationHeader: string | undefined, expectedToken: string): boolean {
  if (!authorizationHeader) return false;
  const prefix = "Bearer ";
  if (!authorizationHeader.startsWith(prefix)) return false;
  const provided = authorizationHeader.slice(prefix.length);
  if (!provided) return false;

  const providedDigest = digest(provided);
  const expectedDigest = digest(expectedToken);
  return crypto.timingSafeEqual(providedDigest, expectedDigest);
}

/** MAIL_CONTROL_TOKEN must be present and >= 32 chars — enforced at process startup, see index.ts. */
export function isTokenStrongEnough(token: string | undefined): token is string {
  return typeof token === "string" && token.length >= 32;
}
