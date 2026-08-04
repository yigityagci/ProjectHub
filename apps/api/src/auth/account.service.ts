import type { User } from "@prisma/client";
import type { UpdatePreferencesInput, UpdateProfileInput } from "@projecthub/shared";
import { prisma } from "../core/prisma.js";
import { ConflictError, UnauthorizedError, ValidationError } from "../core/errors.js";
import { normalizeEmail } from "./auth.service.js";
import { verifyPassword, hashPassword } from "./password.js";
import { revokeAllUserSessions, revokeAllUserSessionsExcept } from "./session.js";

export const EMAIL_IN_USE_MESSAGE = "Email address already in use.";
const CURRENT_PASSWORD_INCORRECT_MESSAGE = "Current password is incorrect.";

function isUniqueConstraintError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "P2002";
}

/**
 * Hand-written response serializer (this codebase never Zod-validates
 * responses — see serializeNotification/serializeAttachment). Wire keys are
 * the NOTIFICATION_TYPES strings, not the raw column names, so columns can
 * be renamed later without changing the API shape.
 */
export function serializeUserSettings(user: User) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    isPlatformAdmin: user.isPlatformAdmin,
    avatarUrl: user.avatarUrl,
    locale: user.locale,
    notifications: {
      mention: user.notifyOnMention,
      task_assigned: user.notifyOnTaskAssigned,
      comment_reply: user.notifyOnCommentReply,
    },
    accessibility: {
      reduceMotion: user.prefersReducedMotion,
      largerText: user.prefersLargerText,
    },
    personalization: {
      defaultBoardView: user.defaultBoardView,
      defaultLandingPage: user.defaultLandingPage,
      compactMode: user.prefersCompactMode,
      showKeyboardShortcutsReference: user.showKeyboardShortcutsReference,
    },
  };
}
export type UserSettings = ReturnType<typeof serializeUserSettings>;

export async function updateProfile(userId: string, input: UpdateProfileInput) {
  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.avatarUrl !== undefined ? { avatarUrl: input.avatarUrl } : {}),
    },
  });
  return serializeUserSettings(user);
}

export async function updatePreferences(userId: string, input: UpdatePreferencesInput) {
  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      ...(input.notifications?.mention !== undefined ? { notifyOnMention: input.notifications.mention } : {}),
      ...(input.notifications?.task_assigned !== undefined
        ? { notifyOnTaskAssigned: input.notifications.task_assigned }
        : {}),
      ...(input.notifications?.comment_reply !== undefined
        ? { notifyOnCommentReply: input.notifications.comment_reply }
        : {}),
      ...(input.locale !== undefined ? { locale: input.locale } : {}),
      ...(input.accessibility?.reduceMotion !== undefined
        ? { prefersReducedMotion: input.accessibility.reduceMotion }
        : {}),
      ...(input.accessibility?.largerText !== undefined
        ? { prefersLargerText: input.accessibility.largerText }
        : {}),
      ...(input.personalization?.defaultBoardView !== undefined
        ? { defaultBoardView: input.personalization.defaultBoardView }
        : {}),
      ...(input.personalization?.defaultLandingPage !== undefined
        ? { defaultLandingPage: input.personalization.defaultLandingPage }
        : {}),
      ...(input.personalization?.compactMode !== undefined
        ? { prefersCompactMode: input.personalization.compactMode }
        : {}),
      ...(input.personalization?.showKeyboardShortcutsReference !== undefined
        ? { showKeyboardShortcutsReference: input.personalization.showKeyboardShortcutsReference }
        : {}),
    },
  });
  return serializeUserSettings(user);
}

export interface ChangeEmailParams {
  userId: string;
  currentSessionId: string;
  currentPassword: string;
  newEmail: string;
}

export async function changeEmail(params: ChangeEmailParams) {
  const user = await prisma.user.findUnique({ where: { id: params.userId } });
  if (!user) throw new UnauthorizedError();

  const passwordOk = await verifyPassword(user.passwordHash, params.currentPassword);
  if (!passwordOk) {
    throw new UnauthorizedError(CURRENT_PASSWORD_INCORRECT_MESSAGE);
  }

  const normalized = normalizeEmail(params.newEmail);
  if (normalized === user.email) {
    throw new ValidationError("This is already your current email address.");
  }

  const existing = await prisma.user.findUnique({ where: { email: normalized } });
  if (existing) {
    throw new ConflictError(EMAIL_IN_USE_MESSAGE);
  }

  let updated: User;
  try {
    // LIMITATION: the new address is applied immediately without an
    // ownership-proof email — a typo locks the user out of password reset.
    // See docs/PHASES.md.
    updated = await prisma.user.update({ where: { id: user.id }, data: { email: normalized } });
  } catch (err) {
    // Closes the check-then-write race against the uniqueness check above.
    if (isUniqueConstraintError(err)) {
      throw new ConflictError(EMAIL_IN_USE_MESSAGE);
    }
    throw err;
  }

  await revokeAllUserSessionsExcept(user.id, params.currentSessionId);

  return serializeUserSettings(updated);
}

export interface ChangePasswordParams {
  userId: string;
  currentSessionId: string | undefined;
  currentPassword: string;
  newPassword: string;
}

export async function changePassword(params: ChangePasswordParams): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: params.userId } });
  if (!user) throw new UnauthorizedError();

  const passwordOk = await verifyPassword(user.passwordHash, params.currentPassword);
  if (!passwordOk) {
    throw new UnauthorizedError(CURRENT_PASSWORD_INCORRECT_MESSAGE);
  }

  // currentPassword was just verified against the stored hash above, so an
  // identical newPassword string is provably the same password.
  if (params.newPassword === params.currentPassword) {
    throw new ValidationError("New password must be different from your current password.");
  }

  const passwordHash = await hashPassword(params.newPassword);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });

  // Ordering mirrors consumePasswordResetToken exactly: the password hash
  // update commits first, session revocation happens after, never inside
  // the same transaction. The caller's own current session is preserved
  // (unlike a password reset, which revokes everything) so the user stays
  // logged in on the device they just used.
  if (params.currentSessionId) {
    await revokeAllUserSessionsExcept(user.id, params.currentSessionId);
  } else {
    // Fail-closed: if we can't identify which session to preserve, revoke
    // everything rather than silently skip revocation.
    await revokeAllUserSessions(user.id);
  }
}
