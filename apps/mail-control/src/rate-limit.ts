import { MUTATING_RATE_LIMIT, READ_RATE_LIMIT } from "./config.js";

/**
 * In-memory, fixed-window rate limiting, independent of any limiter the
 * ProjectHub API applies to its own routes. Keyed by `remoteAddress +
 * opClass` (not by individual operation) — mirrors the two op classes the
 * spec defines: mutating ops share one combined budget, read ops share
 * another. In-memory is correct here for the same reason the mutex
 * (mutex.ts) is in-memory: single, non-replicated process.
 */

export type OpClass = "mutating" | "read";

interface Window {
  count: number;
  windowStartedAt: number;
}

const windows = new Map<string, Window>();

let mutatingLimit = MUTATING_RATE_LIMIT;
let readLimit = READ_RATE_LIMIT;

function limitFor(opClass: OpClass): { max: number; windowMs: number } {
  return opClass === "mutating" ? mutatingLimit : readLimit;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

export function checkAndConsume(remoteAddress: string, opClass: OpClass, now = Date.now()): RateLimitResult {
  const key = `${remoteAddress}:${opClass}`;
  const { max, windowMs } = limitFor(opClass);
  const existing = windows.get(key);

  if (!existing || now - existing.windowStartedAt >= windowMs) {
    windows.set(key, { count: 1, windowStartedAt: now });
    return { allowed: true };
  }

  if (existing.count >= max) {
    const retryAfterSeconds = Math.max(1, Math.ceil((existing.windowStartedAt + windowMs - now) / 1000));
    return { allowed: false, retryAfterSeconds };
  }

  existing.count += 1;
  return { allowed: true };
}

/** Test-only: override the fixed-window limits (production always uses config.ts's constants). */
export function setLimitsForTests(overrides: { mutating?: { max: number; windowMs: number }; read?: { max: number; windowMs: number } }): void {
  if (overrides.mutating) mutatingLimit = overrides.mutating;
  if (overrides.read) readLimit = overrides.read;
}

/** Test-only: clear all counters and restore default limits between test cases. */
export function resetForTests(): void {
  windows.clear();
  mutatingLimit = MUTATING_RATE_LIMIT;
  readLimit = READ_RATE_LIMIT;
}
