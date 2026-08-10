import type { PlatformPostfixConfig } from "@prisma/client";
import type { UpdatePostfixConfigInput } from "@projecthub/shared";
import { prisma } from "../core/prisma.js";
import { encryptSecret } from "../core/secret-box.js";

export const PLATFORM_POSTFIX_CONFIG_ID = "singleton";

/** Raw row or null. Internal use only — carries dkimPrivateKeyCiphertext. */
export async function getPostfixConfigRow(): Promise<PlatformPostfixConfig | null> {
  return prisma.platformPostfixConfig.findUnique({ where: { id: PLATFORM_POSTFIX_CONFIG_ID } });
}

/**
 * Masked, client-safe projection. Mirrors serializePlatformEmailConfig's
 * masking discipline exactly: the stored DKIM private key is represented
 * ONLY as a boolean (`hasDkimKey`) — there is no code path anywhere that
 * returns `dkimPrivateKeyCiphertext` or the decrypted PEM to a client.
 * `senderAddress` is derived, never stored — see PlatformPostfixConfig's
 * doc comment in schema.prisma.
 */
export function serializePostfixConfig(
  row: PlatformPostfixConfig & { updatedBy?: { displayName: string } | null },
) {
  return {
    enabled: row.enabled,
    sendingDomain: row.sendingDomain,
    mailHostname: row.mailHostname,
    senderName: row.senderName,
    replyToAddress: row.replyToAddress,
    senderAddress: `no-reply@${row.sendingDomain}`,
    dkimSelector: row.dkimSelector,
    dkimKeyBits: row.dkimKeyBits,
    dkimSigningEnabled: row.dkimSigningEnabled,
    hasDkimKey: row.dkimPrivateKeyCiphertext !== null,
    dkimPublicKey: row.dkimPublicKey,
    dkimGeneratedAt: row.dkimGeneratedAt,
    destinationRateDelaySeconds: row.destinationRateDelaySeconds,
    destinationConcurrencyLimit: row.destinationConcurrencyLimit,
    messageSizeLimitBytes: row.messageSizeLimitBytes,
    lastAppliedAt: row.lastAppliedAt,
    lastApplyOk: row.lastApplyOk,
    lastApplyError: row.lastApplyError,
    updatedAt: row.updatedAt,
    updatedByDisplayName: row.updatedBy?.displayName ?? null,
  };
}
export type PostfixConfigView = ReturnType<typeof serializePostfixConfig>;

/**
 * Upserts the singleton row. `replyToAddress` uses the same three-way
 * semantics as PlatformEmailConfig's password (undefined = keep, null =
 * clear, string = set) — see updatePostfixConfigSchema's doc comment.
 * DKIM fields are NOT touched here; they're only ever written by
 * generateAndStoreDkimKey (dkim-key route) and by the apply-result writer
 * (see postfix-config.routes.ts).
 */
export async function upsertPostfixConfig(
  input: UpdatePostfixConfigInput,
  updatedById: string,
): Promise<PlatformPostfixConfig & { updatedBy: { displayName: string } | null }> {
  const row = await prisma.platformPostfixConfig.upsert({
    where: { id: PLATFORM_POSTFIX_CONFIG_ID },
    create: {
      id: PLATFORM_POSTFIX_CONFIG_ID,
      enabled: input.enabled,
      sendingDomain: input.sendingDomain,
      mailHostname: input.mailHostname,
      senderName: input.senderName,
      replyToAddress: input.replyToAddress ?? null,
      ...(input.dkimSelector !== undefined ? { dkimSelector: input.dkimSelector } : {}),
      ...(input.dkimSigningEnabled !== undefined ? { dkimSigningEnabled: input.dkimSigningEnabled } : {}),
      destinationRateDelaySeconds: input.destinationRateDelaySeconds,
      destinationConcurrencyLimit: input.destinationConcurrencyLimit,
      messageSizeLimitBytes: input.messageSizeLimitBytes,
      updatedById,
    },
    update: {
      enabled: input.enabled,
      sendingDomain: input.sendingDomain,
      mailHostname: input.mailHostname,
      senderName: input.senderName,
      ...(input.replyToAddress !== undefined ? { replyToAddress: input.replyToAddress } : {}),
      ...(input.dkimSelector !== undefined ? { dkimSelector: input.dkimSelector } : {}),
      ...(input.dkimSigningEnabled !== undefined ? { dkimSigningEnabled: input.dkimSigningEnabled } : {}),
      destinationRateDelaySeconds: input.destinationRateDelaySeconds,
      destinationConcurrencyLimit: input.destinationConcurrencyLimit,
      messageSizeLimitBytes: input.messageSizeLimitBytes,
      updatedById,
    },
    include: { updatedBy: { select: { displayName: true } } },
  });

  return row;
}

/** Persists the outcome of an apply attempt (mail-control.client.ts#applyConfig). */
export async function recordApplyResult(input: {
  ok: boolean;
  error: string | null;
}): Promise<PlatformPostfixConfig & { updatedBy: { displayName: string } | null }> {
  return prisma.platformPostfixConfig.update({
    where: { id: PLATFORM_POSTFIX_CONFIG_ID },
    data: {
      lastAppliedAt: new Date(),
      lastApplyOk: input.ok,
      lastApplyError: input.error,
    },
    include: { updatedBy: { select: { displayName: true } } },
  });
}

/**
 * Stores a freshly generated DKIM keypair against the EXISTING singleton
 * row. `privateKeyPem` is encrypted at rest via core/secret-box.ts;
 * `publicKeySpkiBase64` is public by definition (it's exactly what gets
 * published in the DNS TXT record). Rotation ALWAYS forces
 * `dkimSigningEnabled` back to false: an un-republished DNS record would
 * otherwise start causing DKIM *failures* (worse than no signing at all)
 * the moment Postfix reloads with the new key.
 *
 * Requires a row to already exist (the admin must have saved
 * sendingDomain/mailHostname via PATCH .../postfix-config at least once —
 * those columns have no sensible placeholder default) — the route layer
 * enforces this and returns a clear 422 otherwise.
 */
export async function storeDkimKey(input: {
  selector: string;
  keyBits: number;
  privateKeyPem: string;
  publicKeySpkiBase64: string;
}): Promise<PlatformPostfixConfig> {
  return prisma.platformPostfixConfig.update({
    where: { id: PLATFORM_POSTFIX_CONFIG_ID },
    data: {
      dkimSelector: input.selector,
      dkimKeyBits: input.keyBits,
      dkimPrivateKeyCiphertext: encryptSecret(input.privateKeyPem),
      dkimPublicKey: input.publicKeySpkiBase64,
      dkimGeneratedAt: new Date(),
      dkimSigningEnabled: false,
    },
  });
}

/** Hard-deletes the row (and with it the stored DKIM ciphertext). */
export async function deletePostfixConfig(): Promise<void> {
  await prisma.platformPostfixConfig.deleteMany({ where: { id: PLATFORM_POSTFIX_CONFIG_ID } });
}
