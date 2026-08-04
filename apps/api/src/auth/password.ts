import argon2 from "argon2";
import { env } from "../config/env.js";

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, {
    type: argon2.argon2id,
    memoryCost: env.ARGON2_MEMORY_COST_KIB,
    timeCost: env.ARGON2_TIME_COST,
    parallelism: env.ARGON2_PARALLELISM,
  });
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

/**
 * A pre-computed dummy hash used to keep login timing roughly constant when
 * the supplied email does not match any user, so failed-login responses do
 * not leak whether an account exists via response timing.
 */
let dummyHashPromise: Promise<string> | null = null;
export function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword("dummy-password-for-timing-parity-only!1");
  }
  return dummyHashPromise;
}

/**
 * Written to a soft-deleted account's passwordHash column (see
 * account.service.ts#deleteAccount). Deliberately NOT a valid argon2 PHC
 * string, so `argon2.verify` always throws on it and verifyPassword's
 * try/catch above always returns false — no plaintext can ever match it.
 * passwordHash stays NOT NULL, so this sentinel is required rather than a
 * schema change.
 */
export const DELETED_ACCOUNT_PASSWORD_HASH = "$deleted$no-login$";
