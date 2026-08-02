import type { PlatformEmailConfig } from "@prisma/client";
import type { SmtpSecurityMode, UpdatePlatformEmailConfigInput } from "@projecthub/shared";
import { prisma } from "../core/prisma.js";
import { encryptSecret } from "../core/secret-box.js";

export const PLATFORM_EMAIL_CONFIG_ID = "singleton";

/** Raw row or null. Internal use only — carries passwordCiphertext. */
export async function getPlatformEmailConfigRow(): Promise<PlatformEmailConfig | null> {
  return prisma.platformEmailConfig.findUnique({ where: { id: PLATFORM_EMAIL_CONFIG_ID } });
}

/**
 * Masked, client-safe projection. Mirrors serializeUserSettings /
 * listRegistrationTokens: the stored secret is represented ONLY as a
 * boolean. There is no code path anywhere that returns the ciphertext or
 * the plaintext to a client.
 */
export function serializePlatformEmailConfig(
  row: PlatformEmailConfig & { updatedBy?: { displayName: string } | null },
) {
  return {
    enabled: row.enabled,
    host: row.host,
    port: row.port,
    security: row.security as SmtpSecurityMode,
    username: row.username,
    hasPassword: row.passwordCiphertext !== null,
    fromAddress: row.fromAddress,
    fromName: row.fromName,
    updatedAt: row.updatedAt,
    updatedByDisplayName: row.updatedBy?.displayName ?? null,
  };
}
export type PlatformEmailConfigView = ReturnType<typeof serializePlatformEmailConfig>;

/**
 * Upserts the singleton row. Password semantics (three-way, deliberate):
 *   - input.password === undefined -> keep the existing ciphertext
 *   - input.password === null      -> clear it (unauthenticated relay)
 *   - input.password === "..."     -> encryptSecret() and store
 * This three-way shape is why the endpoint is PATCH, not PUT: the client
 * can never read the current password back, so it can never submit a
 * genuine full replacement.
 */
export async function upsertPlatformEmailConfig(
  input: UpdatePlatformEmailConfigInput,
  updatedById: string,
): Promise<PlatformEmailConfigView> {
  const passwordCiphertext =
    input.password === undefined ? undefined : input.password === null ? null : encryptSecret(input.password);

  const row = await prisma.platformEmailConfig.upsert({
    where: { id: PLATFORM_EMAIL_CONFIG_ID },
    create: {
      id: PLATFORM_EMAIL_CONFIG_ID,
      enabled: input.enabled,
      host: input.host,
      port: input.port,
      security: input.security,
      username: input.username ?? null,
      passwordCiphertext: passwordCiphertext ?? null,
      fromAddress: input.fromAddress,
      fromName: input.fromName ?? null,
      updatedById,
    },
    update: {
      enabled: input.enabled,
      host: input.host,
      port: input.port,
      security: input.security,
      ...(input.username !== undefined ? { username: input.username } : {}),
      ...(passwordCiphertext !== undefined ? { passwordCiphertext } : {}),
      fromAddress: input.fromAddress,
      ...(input.fromName !== undefined ? { fromName: input.fromName } : {}),
      updatedById,
    },
    include: { updatedBy: { select: { displayName: true } } },
  });

  return serializePlatformEmailConfig(row);
}

/** Hard-deletes the row (and with it the stored ciphertext). */
export async function deletePlatformEmailConfig(): Promise<void> {
  await prisma.platformEmailConfig.deleteMany({ where: { id: PLATFORM_EMAIL_CONFIG_ID } });
}
