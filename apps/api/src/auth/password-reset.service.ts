import crypto from "node:crypto";
import { prisma } from "../core/prisma.js";
import { env } from "../config/env.js";
import { NotFoundError } from "../core/errors.js";
import { normalizeEmail, findUserByEmail } from "./auth.service.js";
import { hashToken } from "./session.js";
import { hashPassword } from "./password.js";
import { revokeAllUserSessions } from "./session.js";

/**
 * Single generic message for every token-failure mode (missing, expired,
 * already used) — mirrors invitations.service.ts's INVITATION_INVALID_MESSAGE
 * non-leaking pattern exactly. Never distinguish these cases in the
 * response.
 */
export const PASSWORD_RESET_INVALID_MESSAGE =
  "This password reset link is invalid or has expired. Please request a new one.";

function randomResetToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function buildPasswordResetLink(rawToken: string): string {
  return `${env.WEB_URL}/reset-password?token=${rawToken}`;
}

/**
 * Issues a new password reset token for `email`, if (and only if) it maps
 * to an active user. Returns the raw token in that case, else null. The
 * caller must always respond 200 regardless of which happened — this
 * anti-enumeration control lives at the route layer, not here.
 */
export async function issuePasswordResetToken(email: string): Promise<string | null> {
  const normalized = normalizeEmail(email);
  const user = await findUserByEmail(normalized);
  if (!user || user.status !== "active") {
    return null;
  }

  // Invalidate any prior unused tokens for this user so only the most
  // recently issued link is ever valid at a time.
  await prisma.passwordResetToken.updateMany({
    where: { userId: user.id, usedAt: null },
    data: { usedAt: new Date() },
  });

  const rawToken = randomResetToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + env.PASSWORD_RESET_TTL_HOURS * 3600 * 1000);

  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash,
      expiresAt,
    },
  });

  return rawToken;
}

export interface ConfirmPasswordResetInput {
  rawToken: string;
  newPassword: string;
}

export async function consumePasswordResetToken(
  input: ConfirmPasswordResetInput,
): Promise<{ userId: string }> {
  const tokenHash = hashToken(input.rawToken);

  const userId = await prisma.$transaction(async (tx) => {
    const token = await tx.passwordResetToken.findUnique({ where: { tokenHash } });

    if (!token) {
      throw new NotFoundError(PASSWORD_RESET_INVALID_MESSAGE);
    }
    if (token.usedAt !== null || token.expiresAt < new Date()) {
      throw new NotFoundError(PASSWORD_RESET_INVALID_MESSAGE);
    }

    const passwordHash = await hashPassword(input.newPassword);

    await tx.user.update({
      where: { id: token.userId },
      data: { passwordHash },
    });
    await tx.passwordResetToken.update({
      where: { id: token.id },
      data: { usedAt: new Date() },
    });

    return token.userId;
  });

  await revokeAllUserSessions(userId);

  return { userId };
}
